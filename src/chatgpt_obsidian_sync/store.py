import sqlite3
from dataclasses import dataclass
from dataclasses import field
from pathlib import Path
from typing import Iterable

from .schemas import MessageIn


@dataclass(frozen=True)
class StoreSaveResult:
    inserted: int
    updated: int
    skipped: int
    max_order_index_before: int
    max_order_index_after: int
    inserted_order_indexes: list[int] = field(default_factory=list)
    updated_order_indexes: list[int] = field(default_factory=list)
    skipped_message_ids_tail: list[str] = field(default_factory=list)
    inserted_message_ids: list[str] = field(default_factory=list)
    inserted_tail: list[dict] = field(default_factory=list)

    @property
    def saved(self) -> int:
        return self.inserted


@dataclass(frozen=True)
class ImportSaveResult:
    imported: int
    updated: int
    skipped: int


@dataclass(frozen=True)
class AttachmentRecord:
    conversation_id: str
    message_id: str
    kind: str
    source_url: str
    local_filename: str
    local_relative_path: str
    mime_type: str
    size_bytes: int
    sha256: str


class SQLiteStore:
    def __init__(self, database_path: str | Path):
        self.database_path = Path(database_path)

    def initialize(self) -> None:
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS conversations (
                    id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    has_full_snapshot INTEGER NOT NULL DEFAULT 0,
                    last_full_export_at TEXT,
                    last_realtime_sync_at TEXT,
                    last_seen_message_count INTEGER NOT NULL DEFAULT 0,
                    full_snapshot_quality TEXT NOT NULL DEFAULT 'none',
                    last_full_export_message_count INTEGER NOT NULL DEFAULT 0,
                    last_full_export_mapping_node_count INTEGER NOT NULL DEFAULT 0,
                    last_full_export_candidate_message_count INTEGER NOT NULL DEFAULT 0,
                    last_full_export_warning TEXT
                );

                CREATE TABLE IF NOT EXISTS messages (
                    id TEXT NOT NULL,
                    conversation_id TEXT NOT NULL,
                    role TEXT NOT NULL,
                    content TEXT NOT NULL,
                    position INTEGER NOT NULL,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY (conversation_id, id),
                    FOREIGN KEY (conversation_id) REFERENCES conversations(id)
                );

                CREATE TABLE IF NOT EXISTS attachments (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    conversation_id TEXT NOT NULL,
                    message_id TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    source_url TEXT NOT NULL,
                    local_filename TEXT NOT NULL,
                    local_relative_path TEXT NOT NULL,
                    mime_type TEXT NOT NULL,
                    size_bytes INTEGER NOT NULL,
                    sha256 TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (conversation_id) REFERENCES conversations(id),
                    UNIQUE(conversation_id, message_id, sha256)
                );

                CREATE INDEX IF NOT EXISTS idx_attachments_message
                ON attachments(conversation_id, message_id);

                CREATE INDEX IF NOT EXISTS idx_attachments_sha
                ON attachments(conversation_id, sha256);
                """
            )
            self._ensure_conversation_metadata_columns(connection)

    def save_messages(
        self,
        conversation_id: str,
        title: str,
        messages: Iterable[MessageIn],
        append_new_messages: bool = False,
    ) -> StoreSaveResult:
        inserted = 0
        updated = 0
        skipped = 0
        inserted_order_indexes: list[int] = []
        updated_order_indexes: list[int] = []
        skipped_message_ids: list[str] = []
        inserted_message_ids: list[str] = []
        inserted_tail: list[dict] = []
        message_list = list(messages)
        with self._connect() as connection:
            max_order_index_before = self._max_message_position(connection, conversation_id)
            connection.execute(
                """
                INSERT INTO conversations (id, title)
                VALUES (?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    updated_at = CURRENT_TIMESTAMP
                """,
                (conversation_id, title),
            )
            for message in message_list:
                existing = self._get_message(connection, conversation_id, message.id)
                if (
                    existing is None
                    and append_new_messages
                    and message.id.startswith(f"realtime:{conversation_id}:")
                    and self._find_message_by_role_content(
                        connection, conversation_id, message.role, message.content
                    )
                    is not None
                ):
                    skipped += 1
                    skipped_message_ids.append(message.id)
                    continue
                effective_position = (
                    existing["position"]
                    if existing is not None
                    else self._next_message_position(connection, conversation_id)
                    if append_new_messages
                    or message.id.startswith(f"realtime:{conversation_id}:")
                    else message.position
                )
                connection.execute(
                    """
                    INSERT INTO messages (id, conversation_id, role, content, position)
                    VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT(conversation_id, id) DO UPDATE SET
                        role = excluded.role,
                        content = excluded.content,
                        position = excluded.position,
                        updated_at = CURRENT_TIMESTAMP
                    """,
                    (
                        message.id,
                        conversation_id,
                        message.role,
                        message.content,
                        effective_position,
                    ),
                )
                if existing is None:
                    inserted += 1
                    inserted_order_indexes.append(effective_position)
                    inserted_message_ids.append(message.id)
                    inserted_tail.append(
                        {
                            "role": message.role,
                            "order_index": effective_position,
                            "preview": message.content.replace("\n", " ")[:120],
                        }
                    )
                elif (
                    existing["role"] == message.role
                    and existing["content"] == message.content
                    and existing["position"] == effective_position
                ):
                    skipped += 1
                    skipped_message_ids.append(message.id)
                else:
                    updated += 1
                    updated_order_indexes.append(effective_position)
                self._replace_message_asset_refs(
                    connection,
                    conversation_id,
                    message.id,
                    message.assets,
                )
            self._touch_realtime_sync_metadata(connection, conversation_id)
            max_order_index_after = self._max_message_position(connection, conversation_id)
        return StoreSaveResult(
            inserted=inserted,
            updated=updated,
            skipped=skipped,
            max_order_index_before=max_order_index_before,
            max_order_index_after=max_order_index_after,
            inserted_order_indexes=inserted_order_indexes,
            updated_order_indexes=updated_order_indexes,
            skipped_message_ids_tail=skipped_message_ids[-5:],
            inserted_message_ids=inserted_message_ids,
            inserted_tail=inserted_tail[-5:],
        )

    def import_messages(
        self,
        conversation_id: str,
        title: str,
        messages: Iterable[MessageIn],
        diagnostics: dict | None = None,
    ) -> ImportSaveResult:
        imported = 0
        updated = 0
        skipped = 0
        message_list = list(messages)
        diagnostics = diagnostics or {}
        quality = str(diagnostics.get("full_snapshot_quality") or "ok")
        has_full_snapshot = 1 if quality == "ok" else 0
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO conversations (
                    id,
                    title,
                    has_full_snapshot,
                    last_full_export_at,
                    full_snapshot_quality,
                    last_full_export_message_count,
                    last_full_export_mapping_node_count,
                    last_full_export_candidate_message_count,
                    last_full_export_warning
                )
                VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    title = excluded.title,
                    has_full_snapshot = excluded.has_full_snapshot,
                    last_full_export_at = CURRENT_TIMESTAMP,
                    full_snapshot_quality = excluded.full_snapshot_quality,
                    last_full_export_message_count = excluded.last_full_export_message_count,
                    last_full_export_mapping_node_count = excluded.last_full_export_mapping_node_count,
                    last_full_export_candidate_message_count = excluded.last_full_export_candidate_message_count,
                    last_full_export_warning = excluded.last_full_export_warning,
                    updated_at = CURRENT_TIMESTAMP
                """,
                (
                    conversation_id,
                    title,
                    has_full_snapshot,
                    quality,
                    int(diagnostics.get("parsed_message_count") or len(message_list)),
                    int(diagnostics.get("mapping_node_count") or 0),
                    int(diagnostics.get("candidate_message_node_count") or 0),
                    "; ".join(diagnostics.get("warnings") or []),
                ),
            )
            for message in message_list:
                existing = self._get_message(connection, conversation_id, message.id)
                if existing is None:
                    connection.execute(
                        """
                        INSERT INTO messages (id, conversation_id, role, content, position)
                        VALUES (?, ?, ?, ?, ?)
                        """,
                        (
                            message.id,
                            conversation_id,
                            message.role,
                            message.content,
                            message.position,
                        ),
                    )
                    imported += 1
                    continue

                if (
                    existing["role"] == message.role
                    and existing["content"] == message.content
                    and existing["position"] == message.position
                ):
                    skipped += 1
                    continue

                connection.execute(
                    """
                    UPDATE messages
                    SET role = ?, content = ?, position = ?, updated_at = CURRENT_TIMESTAMP
                    WHERE conversation_id = ? AND id = ?
                    """,
                    (
                        message.role,
                        message.content,
                        message.position,
                        conversation_id,
                        message.id,
                    ),
                )
                updated += 1
            self._touch_full_sync_metadata(connection, conversation_id, diagnostics)
        return ImportSaveResult(
            imported=imported,
            updated=updated,
            skipped=skipped,
        )

    def list_messages(self, conversation_id: str) -> list[dict]:
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT id, role, content, position
                FROM messages
                WHERE conversation_id = ?
                ORDER BY position ASC, created_at ASC, id ASC
                """,
                (conversation_id,),
            ).fetchall()
        return [dict(row) for row in rows]

    def normalize_conversation_order(self, conversation_id: str) -> None:
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT id
                FROM messages
                WHERE conversation_id = ?
                ORDER BY position ASC, created_at ASC, id ASC
                """,
                (conversation_id,),
            ).fetchall()
            for index, row in enumerate(rows):
                connection.execute(
                    """
                    UPDATE messages
                    SET position = ?, updated_at = CURRENT_TIMESTAMP
                    WHERE conversation_id = ? AND id = ?
                    """,
                    (index, conversation_id, row["id"]),
                )

    def find_message_owner(self, message_id: str) -> str | None:
        with self._connect() as connection:
            row = connection.execute(
                """
                SELECT conversation_id
                FROM messages
                WHERE id = ?
                ORDER BY created_at ASC
                LIMIT 1
                """,
                (message_id,),
            ).fetchone()
        return row["conversation_id"] if row else None

    def list_message_attachments(self, conversation_id: str, message_id: str) -> list[dict]:
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT kind, local_relative_path
                FROM attachments
                WHERE conversation_id = ? AND message_id = ?
                ORDER BY id ASC
                """,
                (conversation_id, message_id),
            ).fetchall()
        return [dict(row) for row in rows]

    def find_attachment_by_sha(
        self, conversation_id: str, sha256: str
    ) -> dict | None:
        with self._connect() as connection:
            row = connection.execute(
                """
                SELECT local_filename, local_relative_path, mime_type, size_bytes, sha256
                FROM attachments
                WHERE conversation_id = ? AND sha256 = ?
                ORDER BY id ASC
                LIMIT 1
                """,
                (conversation_id, sha256),
            ).fetchone()
        return dict(row) if row else None

    def save_attachment(self, record: AttachmentRecord) -> dict:
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO conversations (id, title)
                VALUES (?, ?)
                ON CONFLICT(id) DO NOTHING
                """,
                (record.conversation_id, "Untitled Chat"),
            )
            connection.execute(
                """
                INSERT INTO attachments (
                    conversation_id,
                    message_id,
                    kind,
                    source_url,
                    local_filename,
                    local_relative_path,
                    mime_type,
                    size_bytes,
                    sha256
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(conversation_id, message_id, sha256) DO UPDATE SET
                    source_url = excluded.source_url,
                    local_filename = excluded.local_filename,
                    local_relative_path = excluded.local_relative_path,
                    mime_type = excluded.mime_type,
                    size_bytes = excluded.size_bytes
                """,
                (
                    record.conversation_id,
                    record.message_id,
                    record.kind,
                    record.source_url,
                    record.local_filename,
                    record.local_relative_path,
                    record.mime_type,
                    record.size_bytes,
                    record.sha256,
                ),
            )
        return {
            "local_filename": record.local_filename,
            "local_relative_path": record.local_relative_path,
            "mime_type": record.mime_type,
            "size_bytes": record.size_bytes,
            "sha256": record.sha256,
        }

    def get_conversation(self, conversation_id: str) -> dict | None:
        with self._connect() as connection:
            row = connection.execute(
                """
                SELECT
                    id,
                    title,
                    has_full_snapshot,
                    last_full_export_at,
                    last_realtime_sync_at,
                    last_seen_message_count,
                    full_snapshot_quality,
                    last_full_export_message_count,
                    last_full_export_mapping_node_count,
                    last_full_export_candidate_message_count,
                    last_full_export_warning
                FROM conversations
                WHERE id = ?
                """,
                (conversation_id,),
            ).fetchone()
        return dict(row) if row else None

    def conversation_message_count(self, conversation_id: str) -> int:
        with self._connect() as connection:
            return self._message_count(connection, conversation_id)

    def conversation_order_diagnostics(
        self, conversation_id: str, messages_per_part: int
    ) -> dict:
        messages = self.list_messages(conversation_id)
        positions = [int(message["position"]) for message in messages]
        unique_positions = set(positions)
        first_order_index = min(positions) if positions else None
        last_order_index = max(positions) if positions else None
        expected_positions = (
            set(range(first_order_index, last_order_index + 1))
            if first_order_index is not None and last_order_index is not None
            else set()
        )
        missing_order_index_count = len(expected_positions - unique_positions)
        duplicate_order_index_count = len(positions) - len(unique_positions)
        last_message = messages[-1] if messages else None
        part_count = (
            (len(messages) + max(messages_per_part, 1) - 1) // max(messages_per_part, 1)
            if messages
            else 0
        )
        return {
            "db_message_count": len(messages),
            "exported_section_count": len(messages),
            "part_count": part_count,
            "index_link_count": part_count,
            "first_order_index": first_order_index,
            "last_order_index": last_order_index,
            "missing_order_index_count": missing_order_index_count,
            "duplicate_order_index_count": duplicate_order_index_count,
            "order_gap_count": missing_order_index_count,
            "last_exported_text_preview": (
                str(last_message["content"]).replace("\n", " ")[:120] if last_message else ""
            ),
            "last_exported_role": last_message["role"] if last_message else "",
            "last_exported_order_index": int(last_message["position"]) if last_message else None,
            "last_exported_part_filename": (
                f"part-{((len(messages) - 1) // max(messages_per_part, 1)) + 1:03d}.md"
                if messages
                else ""
            ),
        }

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.database_path)
        connection.row_factory = sqlite3.Row
        return connection

    def _message_exists(
        self, connection: sqlite3.Connection, conversation_id: str, message_id: str
    ) -> bool:
        row = connection.execute(
            """
            SELECT EXISTS(
                SELECT 1 FROM messages
                WHERE conversation_id = ? AND id = ?
            ) AS message_exists
            """,
            (conversation_id, message_id),
        ).fetchone()
        return bool(row["message_exists"])

    def _ensure_conversation_metadata_columns(
        self, connection: sqlite3.Connection
    ) -> None:
        existing_columns = {
            row["name"]
            for row in connection.execute("PRAGMA table_info(conversations)").fetchall()
        }
        column_definitions = {
            "has_full_snapshot": "INTEGER NOT NULL DEFAULT 0",
            "last_full_export_at": "TEXT",
            "last_realtime_sync_at": "TEXT",
            "last_seen_message_count": "INTEGER NOT NULL DEFAULT 0",
            "full_snapshot_quality": "TEXT NOT NULL DEFAULT 'none'",
            "last_full_export_message_count": "INTEGER NOT NULL DEFAULT 0",
            "last_full_export_mapping_node_count": "INTEGER NOT NULL DEFAULT 0",
            "last_full_export_candidate_message_count": "INTEGER NOT NULL DEFAULT 0",
            "last_full_export_warning": "TEXT",
        }
        for column_name, definition in column_definitions.items():
            if column_name not in existing_columns:
                connection.execute(
                    f"ALTER TABLE conversations ADD COLUMN {column_name} {definition}"
                )

    def _message_count(
        self, connection: sqlite3.Connection, conversation_id: str
    ) -> int:
        row = connection.execute(
            """
            SELECT COUNT(*) AS message_count
            FROM messages
            WHERE conversation_id = ?
            """,
            (conversation_id,),
        ).fetchone()
        return int(row["message_count"])

    def _next_message_position(
        self, connection: sqlite3.Connection, conversation_id: str
    ) -> int:
        row = connection.execute(
            """
            SELECT COALESCE(MAX(position), -1) + 1 AS next_position
            FROM messages
            WHERE conversation_id = ?
            """,
            (conversation_id,),
        ).fetchone()
        return int(row["next_position"])

    def _max_message_position(
        self, connection: sqlite3.Connection, conversation_id: str
    ) -> int:
        row = connection.execute(
            """
            SELECT COALESCE(MAX(position), -1) AS max_position
            FROM messages
            WHERE conversation_id = ?
            """,
            (conversation_id,),
        ).fetchone()
        return int(row["max_position"])

    def _touch_realtime_sync_metadata(
        self, connection: sqlite3.Connection, conversation_id: str
    ) -> None:
        connection.execute(
            """
            UPDATE conversations
            SET
                last_realtime_sync_at = CURRENT_TIMESTAMP,
                last_seen_message_count = ?,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
            """,
            (self._message_count(connection, conversation_id), conversation_id),
        )

    def _touch_full_sync_metadata(
        self,
        connection: sqlite3.Connection,
        conversation_id: str,
        diagnostics: dict | None = None,
    ) -> None:
        diagnostics = diagnostics or {}
        quality = str(diagnostics.get("full_snapshot_quality") or "ok")
        connection.execute(
            """
            UPDATE conversations
            SET
                has_full_snapshot = ?,
                last_full_export_at = CURRENT_TIMESTAMP,
                full_snapshot_quality = ?,
                last_full_export_message_count = ?,
                last_full_export_mapping_node_count = ?,
                last_full_export_candidate_message_count = ?,
                last_full_export_warning = ?,
                last_seen_message_count = ?,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
            """,
            (
                1 if quality == "ok" else 0,
                quality,
                int(diagnostics.get("parsed_message_count") or 0),
                int(diagnostics.get("mapping_node_count") or 0),
                int(diagnostics.get("candidate_message_node_count") or 0),
                "; ".join(diagnostics.get("warnings") or []),
                self._message_count(connection, conversation_id),
                conversation_id,
            ),
        )

    def _get_message(
        self, connection: sqlite3.Connection, conversation_id: str, message_id: str
    ) -> sqlite3.Row | None:
        return connection.execute(
            """
            SELECT role, content, position
            FROM messages
            WHERE conversation_id = ? AND id = ?
            """,
            (conversation_id, message_id),
        ).fetchone()

    def _find_message_by_role_content(
        self,
        connection: sqlite3.Connection,
        conversation_id: str,
        role: str,
        content: str,
    ) -> sqlite3.Row | None:
        return connection.execute(
            """
            SELECT id, position
            FROM messages
            WHERE conversation_id = ? AND role = ? AND content = ?
            ORDER BY position ASC, created_at ASC
            LIMIT 1
            """,
            (conversation_id, role, content),
        ).fetchone()

    def _delete_messages_not_in(
        self, connection: sqlite3.Connection, conversation_id: str, message_ids: list[str]
    ) -> None:
        if not message_ids:
            connection.execute(
                "DELETE FROM messages WHERE conversation_id = ?",
                (conversation_id,),
            )
            return

        placeholders = ",".join("?" for _ in message_ids)
        connection.execute(
            f"""
            DELETE FROM messages
            WHERE conversation_id = ?
              AND id NOT IN ({placeholders})
            """,
            [conversation_id, *message_ids],
        )

    def _replace_message_asset_refs(
        self,
        connection: sqlite3.Connection,
        conversation_id: str,
        message_id: str,
        assets,
    ) -> None:
        seen_paths: set[str] = set()
        for asset in assets:
            if asset.kind != "image":
                continue
            local_relative_path = asset.local_relative_path
            if local_relative_path in seen_paths:
                continue
            seen_paths.add(local_relative_path)
            row = connection.execute(
                """
                SELECT local_filename, local_relative_path, mime_type, size_bytes, sha256
                FROM attachments
                WHERE conversation_id = ? AND local_relative_path = ?
                ORDER BY id ASC
                LIMIT 1
                """,
                (conversation_id, local_relative_path),
            ).fetchone()
            if row is None:
                continue
            connection.execute(
                """
                INSERT INTO attachments (
                    conversation_id,
                    message_id,
                    kind,
                    source_url,
                    local_filename,
                    local_relative_path,
                    mime_type,
                    size_bytes,
                    sha256
                )
                VALUES (?, ?, 'image', '', ?, ?, ?, ?, ?)
                ON CONFLICT(conversation_id, message_id, sha256) DO UPDATE SET
                    local_filename = excluded.local_filename,
                    local_relative_path = excluded.local_relative_path,
                    mime_type = excluded.mime_type,
                    size_bytes = excluded.size_bytes
                """,
                (
                    conversation_id,
                    message_id,
                    row["local_filename"],
                    row["local_relative_path"],
                    row["mime_type"],
                    row["size_bytes"],
                    row["sha256"],
                ),
            )
