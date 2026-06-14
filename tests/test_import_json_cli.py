import json
import os
import subprocess
import sys
from pathlib import Path


def test_import_json_cli_imports_file_exports_markdown_and_is_idempotent(tmp_path):
    project_root = Path(__file__).resolve().parents[1]
    json_path = tmp_path / "conversation.json"
    config_path = tmp_path / "config.json"
    vault_path = tmp_path / "Vault"
    database_path = tmp_path / "sync.db"

    config_path.write_text(
        json.dumps(
            {
                "vault_path": str(vault_path),
                "base_dir": "AI\\_ChatGPTSyncTest",
                "messages_per_part": 10,
                "server_port": 8765,
                "database_path": str(database_path),
            }
        ),
        encoding="utf-8",
    )
    json_path.write_text(json.dumps(_conversation_json()), encoding="utf-8")

    first = _run_import_json(project_root, tmp_path, json_path)
    second = _run_import_json(project_root, tmp_path, json_path)

    assert first.returncode == 0
    assert second.returncode == 0

    first_output = json.loads(first.stdout)
    second_output = json.loads(second.stdout)
    output_folder = vault_path / "AI" / "_ChatGPTSyncTest" / "Manual JSON Import - cli-conv"

    assert first_output == {
        "conversation_id": "cli-conv",
        "title": "Manual JSON Import",
        "imported_messages": 2,
        "updated_messages": 0,
        "skipped_messages": 0,
        "parsed_message_count": 2,
        "mapping_node_count": 3,
        "candidate_message_node_count": 2,
        "full_snapshot_quality": "ok",
        "warnings": ["current_node missing; used children[0] fallback main chain"],
        "output_folder": str(output_folder),
    }
    assert second_output["imported_messages"] == 0
    assert second_output["updated_messages"] == 0
    assert second_output["skipped_messages"] == 2

    part = output_folder / "part-001.md"
    index = output_folder / "index.md"
    assert part.exists()
    assert index.exists()
    assert part.read_text(encoding="utf-8") == (
        "## 🧑 User\n\nHello from saved JSON\n\n---\n\n"
        "## 🤖 Assistant\n\nReply from saved JSON\n"
    )
    assert part.read_text(encoding="utf-8").count("## 🧑 User") == 1
    assert "- [[part-001]]" in index.read_text(encoding="utf-8")


def test_import_json_cli_reports_missing_file(tmp_path):
    project_root = Path(__file__).resolve().parents[1]

    result = _run_import_json(project_root, tmp_path, tmp_path / "missing.json")

    assert result.returncode == 1
    assert "JSON file not found" in result.stderr


def test_import_json_cli_reports_invalid_json(tmp_path):
    project_root = Path(__file__).resolve().parents[1]
    json_path = tmp_path / "broken.json"
    json_path.write_text("{not json", encoding="utf-8")

    result = _run_import_json(project_root, tmp_path, json_path)

    assert result.returncode == 1
    assert "Failed to parse JSON" in result.stderr


def _run_import_json(project_root: Path, cwd: Path, json_path: Path):
    env = os.environ.copy()
    env["PYTHONPATH"] = str(project_root / "src")
    return subprocess.run(
        [sys.executable, "-m", "chatgpt_obsidian_sync.import_json", str(json_path)],
        cwd=cwd,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )


def _conversation_json():
    return {
        "conversation_id": "cli-conv",
        "title": "Manual JSON Import",
        "mapping": {
            "client-created-root": {
                "message": None,
                "children": ["user-1"],
            },
            "user-1": {
                "message": {
                    "id": "msg-user-1",
                    "author": {"role": "user"},
                    "content": {
                        "content_type": "text",
                        "parts": ["Hello from saved JSON"],
                    },
                },
                "children": ["assistant-1"],
            },
            "assistant-1": {
                "message": {
                    "id": "msg-assistant-1",
                    "author": {"role": "assistant"},
                    "content": {
                        "content_type": "text",
                        "parts": ["Reply from saved JSON"],
                    },
                },
                "children": [],
            },
        },
    }
