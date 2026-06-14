import base64
import hashlib
import logging
import mimetypes
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse

from .config import AppConfig, config_to_json_dict, load_config, save_config
from .exporter import export_conversation, safe_path_segment
from .importer import parse_conversation_json
from .schemas import AssetUploadIn, ConversationIn
from .store import AttachmentRecord, SQLiteStore

VAULT_MISSING_ERROR = "Vault 路径不存在，请先在设置页选择 Obsidian Vault 文件夹。"
FULL_SNAPSHOT_STALE_AFTER = timedelta(hours=6)
logger = logging.getLogger(__name__)


def create_app(
    config: AppConfig | None = None, config_path: str | Path = "config.json"
) -> FastAPI:
    config_file = Path(config_path)
    state = {"config": config or load_config(config_file)}
    store = SQLiteStore(state["config"].database_path)
    store.initialize()

    app = FastAPI(title="ChatGPT Obsidian Sync")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[
            "https://chatgpt.com",
            "https://chat.openai.com",
            "http://127.0.0.1",
            "http://localhost",
        ],
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["*"],
    )

    def current_config() -> AppConfig:
        return state["config"]

    def error_response(message: str, status_code: int = 400) -> JSONResponse:
        return JSONResponse(status_code=status_code, content={"ok": False, "error": message})

    def error_payload_response(payload: dict[str, Any], status_code: int = 400) -> JSONResponse:
        return JSONResponse(status_code=status_code, content={"ok": False, **payload})

    def realtime_payload_summary(payload: ConversationIn) -> dict[str, Any]:
        message_conversation_ids = sorted(
            {
                message.conversation_id or ""
                for message in payload.messages
                if message.conversation_id is not None
            }
        )
        return {
            "payload_conversation_id": payload.conversation_id,
            "message_conversation_ids": message_conversation_ids,
            "message_count": len(payload.messages),
            "first_message_ids": [message.id for message in payload.messages[:5]],
        }

    def log_realtime_rejection(error_type: str, summary: dict[str, Any]) -> None:
        logger.warning(
            "Rejected /api/messages realtime payload",
            extra={
                "error_type": error_type,
                "payload_conversation_id": summary.get("payload_conversation_id"),
                "message_conversation_ids": summary.get("message_conversation_ids"),
                "message_count": summary.get("message_count"),
                "first_message_ids": summary.get("first_message_ids"),
            },
        )

    def config_payload() -> dict[str, Any]:
        cfg = current_config()
        output_base = Path(cfg.vault_path).joinpath(*cfg.base_dir.split("/"))
        return {
            "ok": True,
            "config": config_to_json_dict(cfg),
            "vault_exists": Path(cfg.vault_path).exists(),
            "output_base": str(output_base),
        }

    def vault_error_if_missing() -> JSONResponse | None:
        if not Path(current_config().vault_path).exists():
            return error_response(VAULT_MISSING_ERROR)
        return None

    def parse_store_timestamp(value: str | None) -> datetime | None:
        if not value:
            return None
        normalized = value.replace("Z", "+00:00")
        try:
            parsed = datetime.fromisoformat(normalized)
        except ValueError:
            try:
                parsed = datetime.strptime(value, "%Y-%m-%d %H:%M:%S")
            except ValueError:
                return None
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)

    def conversation_status_payload(conversation_id: str) -> dict[str, Any]:
        conversation = store.get_conversation(conversation_id)
        order_diagnostics = store.conversation_order_diagnostics(
            conversation_id, current_config().messages_per_part
        )
        if conversation is None:
            return {
                "ok": True,
                "conversation_id": conversation_id,
                "exists": False,
                "has_full_snapshot": False,
                "message_count": 0,
                "last_full_export_at": None,
                "last_realtime_sync_at": None,
                "full_snapshot_quality": "none",
                "last_full_export_message_count": 0,
                "last_full_export_mapping_node_count": 0,
                "last_full_export_candidate_message_count": 0,
            "last_full_export_warning": "",
            "needs_recalibration": True,
            "reason": "no_full_snapshot",
            "output_folder": "",
            **order_diagnostics,
        }

        has_full_snapshot = bool(conversation.get("has_full_snapshot"))
        message_count = store.conversation_message_count(conversation_id)
        last_full_export_at = conversation.get("last_full_export_at")
        last_full = parse_store_timestamp(last_full_export_at)
        needs_recalibration = False
        reason = ""
        if not has_full_snapshot:
            needs_recalibration = True
            reason = "no_full_snapshot"
        elif last_full is None or (
            datetime.now(timezone.utc) - last_full > FULL_SNAPSHOT_STALE_AFTER
        ):
            needs_recalibration = True
            reason = "full_snapshot_stale"

        return {
            "ok": True,
            "conversation_id": conversation_id,
            "exists": True,
            "title": conversation["title"],
            "has_full_snapshot": has_full_snapshot,
            "message_count": message_count,
            "last_full_export_at": last_full_export_at,
            "last_realtime_sync_at": conversation.get("last_realtime_sync_at"),
            "full_snapshot_quality": conversation.get("full_snapshot_quality") or "none",
            "last_full_export_message_count": conversation.get("last_full_export_message_count")
            or 0,
            "last_full_export_mapping_node_count": conversation.get(
                "last_full_export_mapping_node_count"
            )
            or 0,
            "last_full_export_candidate_message_count": conversation.get(
                "last_full_export_candidate_message_count"
            )
            or 0,
            "last_full_export_warning": conversation.get("last_full_export_warning") or "",
            "needs_recalibration": needs_recalibration,
            "reason": reason,
            "output_folder": str(conversation_dir(conversation_id, conversation["title"])),
            **order_diagnostics,
        }

    def conversation_dir(conversation_id: str, title: str) -> Path:
        cfg = current_config()
        folder_name = f"{safe_path_segment(title)} - {safe_path_segment(conversation_id)}"
        return Path(cfg.vault_path).joinpath(*cfg.base_dir.split("/"), folder_name)

    def extension_for_asset(mime_type: str, suggested_ext: str) -> str:
        cleaned = (suggested_ext or "").strip().lower()
        if cleaned and not cleaned.startswith("."):
            cleaned = f".{cleaned}"
        if cleaned in {".png", ".jpg", ".jpeg", ".webp", ".gif"}:
            return ".jpg" if cleaned == ".jpeg" else cleaned
        guessed = mimetypes.guess_extension(mime_type.split(";")[0].strip().lower())
        if guessed == ".jpe":
            return ".jpg"
        if guessed in {".png", ".jpg", ".jpeg", ".webp", ".gif"}:
            return ".jpg" if guessed == ".jpeg" else guessed
        return ".bin"

    def payload_conversation_mismatch_error(payload: ConversationIn) -> JSONResponse:
        summary = realtime_payload_summary(payload)
        mismatch_count = sum(
            1
            for message in payload.messages
            if not message.conversation_id
            or message.conversation_id != payload.conversation_id
        )
        log_realtime_rejection("payload conversation_id mismatch", summary)
        return error_payload_response(
            {
                "error": "payload conversation_id mismatch",
                "payload_conversation_id": payload.conversation_id,
                "message_conversation_ids": summary["message_conversation_ids"],
                "mismatch_count": mismatch_count,
            }
        )

    def message_owner_mismatch_error(
        message_id: str, existing_conversation_id: str, payload_conversation_id: str
    ) -> JSONResponse:
        logger.warning(
            "Rejected /api/messages realtime payload",
            extra={
                "error_type": "message_id already belongs to another conversation",
                "message_id": message_id,
                "existing_conversation_id": existing_conversation_id,
                "payload_conversation_id": payload_conversation_id,
            },
        )
        return error_payload_response(
            {
                "error": "message_id already belongs to another conversation",
                "message_id": message_id,
                "existing_conversation_id": existing_conversation_id,
                "payload_conversation_id": payload_conversation_id,
            }
        )

    def is_realtime_fallback_message_id(message_id: str, conversation_id: str) -> bool:
        return message_id.startswith(f"realtime:{conversation_id}:")

    def is_legacy_page_conversation_id(conversation_id: str | None) -> bool:
        return str(conversation_id or "").startswith("page-")

    def validate_message_conversation_binding(
        payload: ConversationIn,
    ) -> tuple[JSONResponse | None, list[str]]:
        warnings: list[str] = []
        if not payload.conversation_id:
            return payload_conversation_mismatch_error(payload), warnings
        for message in payload.messages:
            if message.conversation_id and message.conversation_id != payload.conversation_id:
                return payload_conversation_mismatch_error(payload), warnings
            if is_realtime_fallback_message_id(message.id, payload.conversation_id):
                continue
            existing_owner = store.find_message_owner(message.id)
            if existing_owner is not None and existing_owner != payload.conversation_id:
                if is_legacy_page_conversation_id(existing_owner):
                    warnings.append("ignored legacy page-* owner conflict")
                    logger.warning(
                        "Ignored legacy page-* realtime owner conflict",
                        extra={
                            "message_id": message.id,
                            "existing_conversation_id": existing_owner,
                            "payload_conversation_id": payload.conversation_id,
                        },
                    )
                    continue
                return (
                    message_owner_mismatch_error(
                        message.id,
                        existing_owner,
                        payload.conversation_id,
                    ),
                    warnings,
                )
        return None, warnings

    def validate_message_ids_owned_by(conversation_id: str, messages) -> JSONResponse | None:
        if not conversation_id:
            return error_response("conversation_id is required")
        for message in messages:
            if is_realtime_fallback_message_id(message.id, conversation_id):
                continue
            existing_owner = store.find_message_owner(message.id)
            if existing_owner is not None and existing_owner != conversation_id:
                return message_owner_mismatch_error(message.id, existing_owner, conversation_id)
        return None

    @app.exception_handler(RequestValidationError)
    async def validation_exception_handler(request, exc: RequestValidationError):
        errors = exc.errors()
        if request.url.path == "/api/messages" and any(
            tuple(error.get("loc", ())) == ("body", "conversation_id")
            for error in errors
        ):
            return error_payload_response(
                {
                    "error": "payload conversation_id mismatch",
                    "payload_conversation_id": "",
                    "message_conversation_ids": [],
                    "mismatch_count": 0,
                }
            )
        return error_payload_response(
            {
                "error": "validation error",
                "details": errors,
            },
            status_code=422,
        )

    @app.get("/health")
    def health():
        return {"status": "ok"}

    @app.get("/", response_class=HTMLResponse)
    def settings_page():
        cfg = current_config()
        vault_exists = Path(cfg.vault_path).exists()
        output_base = Path(cfg.vault_path).joinpath(*cfg.base_dir.split("/"))
        vault_error = (
            ""
            if vault_exists
            else f'<div class="alert error">{VAULT_MISSING_ERROR}</div>'
        )
        return f"""<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ChatGPT Obsidian Sync</title>
  <style>
    body {{ margin: 0; font-family: "Segoe UI", Arial, sans-serif; background: #f7f7f4; color: #1d2522; }}
    main {{ max-width: 920px; margin: 0 auto; padding: 32px 20px 48px; }}
    h1 {{ font-size: 28px; margin: 0 0 8px; }}
    h2 {{ font-size: 18px; margin: 28px 0 12px; }}
    .muted {{ color: #64706b; }}
    .panel {{ background: #fff; border: 1px solid #d8ded9; border-radius: 8px; padding: 20px; margin-top: 16px; }}
    .grid {{ display: grid; gap: 14px; }}
    label {{ display: grid; gap: 6px; font-weight: 600; }}
    input {{ font: inherit; padding: 10px 12px; border: 1px solid #b9c3bd; border-radius: 6px; }}
    button {{ font: inherit; padding: 10px 14px; border: 0; border-radius: 6px; background: #1f6f57; color: white; cursor: pointer; }}
    button.secondary {{ background: #47524e; }}
    code {{ background: #edf0ed; padding: 2px 5px; border-radius: 4px; }}
    .alert {{ padding: 12px 14px; border-radius: 6px; margin-top: 16px; }}
    .error {{ background: #fff0ef; border: 1px solid #d7554a; color: #8f1f18; }}
    .success {{ background: #eef8f2; border: 1px solid #48a36d; color: #1c6a3a; }}
    .row {{ display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }}
    @media (max-width: 640px) {{ main {{ padding: 22px 14px 36px; }} }}
  </style>
</head>
<body>
<main>
  <h1>ChatGPT Obsidian Sync</h1>
  <p class="muted">本地同步器正在运行。先确认 Obsidian Vault，再安装浏览器扩展导入当前会话。</p>
  {vault_error}

  <section class="panel">
    <h2>服务状态</h2>
    <p>状态：<strong>运行中</strong></p>
    <p>Vault：<code>{cfg.vault_path}</code></p>
    <p>输出目录：<code>{output_base}</code></p>
  </section>

  <section class="panel">
    <h2>设置</h2>
    <form id="config-form" class="grid">
      <label>Obsidian Vault 路径
        <input name="vault_path" value="{cfg.vault_path}" placeholder="C:\\Users\\你的名字\\OneDrive\\Obsidian">
      </label>
      <label>同步输出目录
        <input name="base_dir" value="{cfg.base_dir}" placeholder="AI\\_ChatGPTSyncTest">
      </label>
      <label>每个 part 文件消息数
        <input name="messages_per_part" type="number" min="1" value="{cfg.messages_per_part}">
      </label>
      <label>服务端口
        <input name="server_port" type="number" min="1" max="65535" value="{cfg.server_port}">
      </label>
      <div class="row">
        <button type="submit">保存设置</button>
        <button type="button" class="secondary" id="test-write">测试写入</button>
      </div>
    </form>
    <div id="status"></div>
  </section>

  <section class="panel">
    <h2>浏览器扩展安装说明</h2>
    <p>打开 Chrome、Edge 或 Opera 的扩展管理页面，开启开发者模式，选择“加载已解压的扩展程序”，然后选择项目里的 <code>browser-extension</code> 文件夹。</p>
    <p>安装后打开 ChatGPT 会话页，点击扩展按钮，再点击“导入当前完整会话”。扩展会临时监听当前标签页的会话 JSON 响应，并发送到本地同步器。</p>
  </section>
</main>
<script>
const statusBox = document.getElementById("status");
function showStatus(message, ok) {{
  statusBox.className = ok ? "alert success" : "alert error";
  statusBox.textContent = message;
}}
document.getElementById("config-form").addEventListener("submit", async (event) => {{
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const payload = {{
    vault_path: form.get("vault_path"),
    base_dir: form.get("base_dir"),
    messages_per_part: Number(form.get("messages_per_part")),
    server_port: Number(form.get("server_port"))
  }};
  const res = await fetch("/api/config", {{
    method: "POST",
    headers: {{ "Content-Type": "application/json" }},
    body: JSON.stringify(payload)
  }});
  const data = await res.json();
  showStatus(data.ok ? "设置已保存。" : data.error, data.ok);
}});
document.getElementById("test-write").addEventListener("click", async () => {{
  const res = await fetch("/api/test-write", {{ method: "POST" }});
  const data = await res.json();
  showStatus(data.ok ? `测试写入成功：${{data.test_file}}` : data.error, data.ok);
}});
</script>
</body>
</html>"""

    @app.get("/api/config")
    def get_config():
        return config_payload()

    @app.get("/api/conversation/status")
    def conversation_status(conversation_id: str):
        if not conversation_id:
            return error_response("conversation_id is required")
        return conversation_status_payload(conversation_id)

    @app.post("/api/config")
    def update_config(payload: dict[str, Any]):
        try:
            existing = current_config()
            merged = config_to_json_dict(existing)
            for key in ("vault_path", "base_dir", "messages_per_part", "server_port"):
                if key in payload:
                    merged[key] = payload[key]
            new_config = AppConfig(**merged, database_path=existing.database_path)
            state["config"] = new_config
            save_config(new_config, config_file)
            return config_payload()
        except Exception as exc:
            return error_response(f"保存设置失败：{exc}")

    @app.post("/api/test-write")
    def test_write():
        missing = vault_error_if_missing()
        if missing is not None:
            return missing
        cfg = current_config()
        output_base = Path(cfg.vault_path).joinpath(*cfg.base_dir.split("/"))
        output_base.mkdir(parents=True, exist_ok=True)
        test_file = output_base / "_sync-test.md"
        test_file.write_text(
            "# ChatGPT Obsidian Sync\n\n本地写入测试成功。\n",
            encoding="utf-8",
        )
        return {"ok": True, "test_file": str(test_file)}

    @app.post("/api/assets")
    def save_asset(payload: AssetUploadIn):
        missing = vault_error_if_missing()
        if missing is not None:
            return missing
        try:
            binary = base64.b64decode(payload.base64_data, validate=True)
            sha256 = hashlib.sha256(binary).hexdigest()
            ext = extension_for_asset(payload.mime_type, payload.suggested_ext)

            store.save_messages(payload.conversation_id, payload.title, [])
            conversation = store.get_conversation(payload.conversation_id) or {
                "title": payload.title
            }
            existing = store.find_attachment_by_sha(payload.conversation_id, sha256)
            if existing is not None:
                filename = existing["local_filename"]
                local_relative_path = existing["local_relative_path"]
            else:
                filename = f"img-{sha256[:12]}{ext}"
                local_relative_path = f"assets/{filename}"

            folder = conversation_dir(payload.conversation_id, conversation["title"])
            assets_dir = folder / "assets"
            assets_dir.mkdir(parents=True, exist_ok=True)
            asset_path = assets_dir / filename
            if not asset_path.exists():
                asset_path.write_bytes(binary)

            result = store.save_attachment(
                AttachmentRecord(
                    conversation_id=payload.conversation_id,
                    message_id=payload.message_id,
                    kind="image",
                    source_url=payload.source_url[:500],
                    local_filename=filename,
                    local_relative_path=local_relative_path,
                    mime_type=payload.mime_type,
                    size_bytes=len(binary),
                    sha256=sha256,
                )
            )
            return {
                "ok": True,
                "local_relative_path": result["local_relative_path"],
                "filename": result["local_filename"],
                "sha256": result["sha256"],
            }
        except Exception as exc:
            return error_response(f"图片保存失败：{exc}")

    @app.post("/api/messages")
    def save_messages(payload: ConversationIn):
        missing = vault_error_if_missing()
        if missing is not None:
            return missing
        mismatch, owner_warnings = validate_message_conversation_binding(payload)
        if mismatch is not None:
            return mismatch
        try:
            result = store.save_messages(
                payload.conversation_id,
                payload.title,
                payload.messages,
                append_new_messages=payload.source == "extension-content-realtime",
            )
            message_count_after = store.conversation_message_count(payload.conversation_id)
            conversation = store.get_conversation(payload.conversation_id)
            output_folder = (
                str(conversation_dir(payload.conversation_id, conversation["title"]))
                if conversation is not None
                else ""
            )
            export_attempted = result.inserted > 0 or result.updated > 0
            exported = False
            updated_files: list[str] = []
            export_error = None
            export_completed_at = ""
            order_diagnostics = store.conversation_order_diagnostics(
                payload.conversation_id, current_config().messages_per_part
            )
            warnings: list[str] = list(owner_warnings)
            if export_attempted:
                try:
                    export = export_conversation(
                        current_config(), store, payload.conversation_id
                    )
                    output_folder = str(export.conversation_dir)
                    updated_files = export.updated_files
                    warnings.extend(export.warnings)
                    exported = True
                    export_completed_at = datetime.now(timezone.utc).isoformat()
                    order_diagnostics = store.conversation_order_diagnostics(
                        payload.conversation_id, current_config().messages_per_part
                    )
                except Exception as export_exc:
                    export_error = str(export_exc)
                    warnings.append("database updated but markdown export failed")
            else:
                warnings.append("no content changes")
            realtime_fallback_message_count = sum(
                1
                for message in payload.messages
                if is_realtime_fallback_message_id(message.id, payload.conversation_id)
            )
            last_order_warning = (
                "realtime fallback messages appended without reordering full snapshot messages"
                if realtime_fallback_message_count
                else ""
            )
            return {
                "ok": True,
                "status": "ok",
                "conversation_id": payload.conversation_id,
                "source": payload.source,
                "is_partial_snapshot": payload.is_partial_snapshot,
                "received_messages": len(payload.messages),
                "inserted_messages": result.inserted,
                "updated_messages": result.updated,
                "skipped_messages": result.skipped,
                "message_count_after": message_count_after,
                "max_order_index_before": result.max_order_index_before,
                "max_order_index_after": result.max_order_index_after,
                "inserted_order_indexes": result.inserted_order_indexes,
                "updated_order_indexes": result.updated_order_indexes,
                "skipped_message_ids_tail": result.skipped_message_ids_tail,
                "inserted_message_ids": result.inserted_message_ids,
                "inserted_tail": result.inserted_tail,
                "export_attempted": export_attempted,
                "exported": exported,
                "output_folder": output_folder,
                "updated_files": updated_files,
                "export_error": export_error,
                "warnings": warnings,
                "last_successful_export_at": export_completed_at if exported else "",
                "last_successful_export_output_folder": output_folder if exported else "",
                "last_successful_export_updated_files": updated_files if exported else [],
                "last_successful_export_section_count": order_diagnostics[
                    "exported_section_count"
                ]
                if exported
                else 0,
                "last_successful_export_part_count": order_diagnostics["part_count"]
                if exported
                else 0,
                "last_successful_export_last_text_preview": order_diagnostics[
                    "last_exported_text_preview"
                ]
                if exported
                else "",
                "last_successful_export_last_role": order_diagnostics["last_exported_role"]
                if exported
                else "",
                "last_successful_export_last_order_index": order_diagnostics[
                    "last_exported_order_index"
                ]
                if exported
                else None,
                "last_successful_export_last_part_filename": order_diagnostics[
                    "last_exported_part_filename"
                ]
                if exported
                else "",
                "realtime_fallback_message_count": realtime_fallback_message_count,
                "last_order_warning": last_order_warning,
                "saved": result.saved,
                "skipped": result.skipped,
                "conversation_dir": output_folder,
                "part_files": updated_files,
                "index_file": "index.md" if "index.md" in updated_files else "",
            }
        except Exception as exc:
            return error_response(f"保存消息失败：{exc}")

    @app.post("/api/conversation/export")
    def regenerate_conversation_export(payload: dict[str, Any]):
        missing = vault_error_if_missing()
        if missing is not None:
            return missing
        conversation_id = str(payload.get("conversation_id") or "")
        if not conversation_id:
            return error_response("conversation_id is required")
        try:
            before_diagnostics = store.conversation_order_diagnostics(
                conversation_id, current_config().messages_per_part
            )
            if (
                before_diagnostics["missing_order_index_count"]
                or before_diagnostics["duplicate_order_index_count"]
                or before_diagnostics["order_gap_count"]
            ):
                store.normalize_conversation_order(conversation_id)
            export = export_conversation(current_config(), store, conversation_id)
            order_diagnostics = store.conversation_order_diagnostics(
                conversation_id, current_config().messages_per_part
            )
            return {
                "ok": True,
                "conversation_id": conversation_id,
                "export_attempted": True,
                "exported": True,
                "output_folder": str(export.conversation_dir),
                "updated_files": export.updated_files,
                "export_error": None,
                "warnings": export.warnings,
                **order_diagnostics,
            }
        except Exception as exc:
            conversation = store.get_conversation(conversation_id)
            order_diagnostics = store.conversation_order_diagnostics(
                conversation_id, current_config().messages_per_part
            )
            return {
                "ok": True,
                "conversation_id": conversation_id,
                "export_attempted": True,
                "exported": False,
                "output_folder": str(conversation_dir(conversation_id, conversation["title"]))
                if conversation
                else "",
                "updated_files": [],
                "export_error": str(exc),
                "warnings": ["markdown export failed"],
                **order_diagnostics,
            }

    @app.post("/api/conversation/import")
    def import_conversation(payload: dict[str, Any]):
        missing = vault_error_if_missing()
        if missing is not None:
            return missing
        try:
            parsed = parse_conversation_json(payload)
            mismatch = validate_message_ids_owned_by(parsed.conversation_id, parsed.messages)
            if mismatch is not None:
                return mismatch
            result = store.import_messages(
                parsed.conversation_id,
                parsed.title,
                parsed.messages,
                parsed.diagnostics,
            )
            export = export_conversation(current_config(), store, parsed.conversation_id)
            has_full_snapshot = parsed.diagnostics["full_snapshot_quality"] == "ok"
            response_payload = {
                "status": "ok",
                "ok": True,
                "conversation_id": parsed.conversation_id,
                "source": "conversation-json-full",
                "is_partial_snapshot": False,
                "imported_messages": result.imported,
                "updated_messages": result.updated,
                "skipped_messages": result.skipped,
                "parsed_message_count": parsed.diagnostics["parsed_message_count"],
                "mapping_node_count": parsed.diagnostics["mapping_node_count"],
                "candidate_message_node_count": parsed.diagnostics[
                    "candidate_message_node_count"
                ],
                "main_chain_message_count": parsed.diagnostics["main_chain_message_count"],
                "branch_count": parsed.diagnostics["branch_count"],
                "branched_node_count": parsed.diagnostics["branched_node_count"],
                "has_full_snapshot": has_full_snapshot,
                "full_snapshot_quality": parsed.diagnostics["full_snapshot_quality"],
                "warnings": parsed.diagnostics["warnings"],
                "output_folder": str(export.conversation_dir),
            }
            if not has_full_snapshot:
                return error_payload_response(
                    {
                        **response_payload,
                        "status": "error",
                        "ok": False,
                        "error": "full snapshot appears incomplete",
                        "has_full_snapshot": False,
                    }
                )
            return response_payload
        except Exception as exc:
            return error_response(f"导入完整会话失败：{exc}")

    return app


app = create_app()
