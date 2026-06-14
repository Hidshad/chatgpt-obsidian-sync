import re
import time
from dataclasses import dataclass
from pathlib import Path

from .config import AppConfig
from .store import SQLiteStore


@dataclass(frozen=True)
class ExportResult:
    conversation_dir: Path
    part_files: list[Path]
    index_file: Path
    updated_files: list[str]
    warnings: list[str]


def safe_path_segment(value: str) -> str:
    cleaned = re.sub(r'[<>:"/\\|?*]+', "-", value).strip(" .-")
    cleaned = re.sub(r"\s+", " ", cleaned)
    return cleaned[:120] or "Untitled Chat"


def render_message_section(message: dict) -> str:
    role = message["role"]
    if role == "user":
        header = "## 🧑 User"
    elif role == "assistant":
        header = "## 🤖 Assistant"
    else:
        header = f"## {role.title()}"

    content = message["content"].replace("\r\n", "\n").replace("\r", "\n")
    asset_lines = [
        f"![[{asset['local_relative_path']}]]"
        for asset in message.get("assets", [])
        if asset.get("kind") == "image" and asset.get("local_relative_path")
    ]
    body_parts = [part for part in [content, "\n\n".join(asset_lines)] if part]
    return f"{header}\n\n" + "\n\n".join(body_parts)


def export_conversation(
    config: AppConfig, store: SQLiteStore, conversation_id: str
) -> ExportResult:
    conversation = store.get_conversation(conversation_id)
    if conversation is None:
        raise ValueError(f"Conversation not found: {conversation_id}")

    messages = store.list_messages(conversation_id)
    for message in messages:
        message["assets"] = store.list_message_attachments(conversation_id, message["id"])
    folder_name = f"{safe_path_segment(conversation['title'])} - {safe_path_segment(conversation_id)}"
    conversation_dir = Path(config.vault_path).joinpath(*config.base_dir.split("/"), folder_name)
    conversation_dir.mkdir(parents=True, exist_ok=True)

    part_files: list[Path] = []
    updated_files: list[str] = []
    warnings: list[str] = []
    for index in range(0, len(messages), config.messages_per_part):
        part_number = len(part_files) + 1
        part_messages = messages[index : index + config.messages_per_part]
        part_path = conversation_dir / f"part-{part_number:03d}.md"
        body = "\n\n---\n\n".join(render_message_section(message) for message in part_messages)
        write_result = _atomic_write_text(part_path, body + ("\n" if body else ""))
        if write_result["updated"]:
            updated_files.append(part_path.name)
        warnings.extend(write_result["warnings"])
        part_files.append(part_path)

    expected_part_names = {part.name for part in part_files}
    for stale_part in conversation_dir.glob("part-*.md"):
        if stale_part.name not in expected_part_names:
            stale_part.unlink()

    index_file = conversation_dir / "index.md"
    index_result = _atomic_write_text(
        index_file, _render_index(conversation["title"], conversation_id, part_files)
    )
    if index_result["updated"]:
        updated_files.append(index_file.name)
    warnings.extend(index_result["warnings"])
    return ExportResult(
        conversation_dir=conversation_dir,
        part_files=part_files,
        index_file=index_file,
        updated_files=updated_files,
        warnings=warnings,
    )


def _atomic_write_text(path: Path, content: str) -> dict:
    if path.exists() and path.read_text(encoding="utf-8") == content:
        return {"updated": False, "warnings": []}
    temp_path = path.with_name(f"{path.name}.tmp")
    temp_path.write_text(content, encoding="utf-8")
    warnings = safe_replace(temp_path, path)
    return {"updated": True, "warnings": warnings}


def _is_retryable_replace_error(error: OSError) -> bool:
    winerror = getattr(error, "winerror", None)
    return isinstance(error, PermissionError) or winerror in {5, 32}


def safe_replace(temp_path: Path, final_path: Path) -> list[str]:
    delays = [0.2, 0.5, 1, 1.5, 2]
    attempts = 0
    while True:
        try:
            temp_path.replace(final_path)
            if attempts:
                return [f"{final_path.name} replace retried {attempts} time(s)"]
            return []
        except OSError as error:
            if attempts >= len(delays) or not _is_retryable_replace_error(error):
                raise
            time.sleep(delays[attempts])
            attempts += 1


def _render_index(title: str, conversation_id: str, part_files: list[Path]) -> str:
    lines = [
        f"# {title}",
        "",
        f"- Conversation ID: `{conversation_id}`",
        f"- Parts: {len(part_files)}",
        "",
        "## Parts",
        "",
    ]
    lines.extend(f"- [[{part.stem}]]" for part in part_files)
    return "\n".join(lines).rstrip() + "\n"
