import argparse
import json
import sys
from json import JSONDecodeError
from pathlib import Path
from typing import Any

from .config import load_config
from .exporter import export_conversation
from .importer import parse_conversation_json
from .store import SQLiteStore


def import_json_file(json_path: str | Path) -> dict[str, Any]:
    path = Path(json_path).expanduser()
    if not path.exists():
        raise FileNotFoundError(f"JSON file not found: {path}")
    if not path.is_file():
        raise FileNotFoundError(f"JSON path is not a file: {path}")

    conversation_json = json.loads(path.read_text(encoding="utf-8"))
    parsed = parse_conversation_json(conversation_json)

    config = load_config()
    store = SQLiteStore(config.database_path)
    store.initialize()
    result = store.import_messages(
        parsed.conversation_id,
        parsed.title,
        parsed.messages,
        parsed.diagnostics,
    )
    export = export_conversation(config, store, parsed.conversation_id)

    return {
        "conversation_id": parsed.conversation_id,
        "title": parsed.title,
        "imported_messages": result.imported,
        "updated_messages": result.updated,
        "skipped_messages": result.skipped,
        "parsed_message_count": parsed.diagnostics["parsed_message_count"],
        "mapping_node_count": parsed.diagnostics["mapping_node_count"],
        "candidate_message_node_count": parsed.diagnostics["candidate_message_node_count"],
        "full_snapshot_quality": parsed.diagnostics["full_snapshot_quality"],
        "warnings": parsed.diagnostics["warnings"],
        "output_folder": str(export.conversation_dir),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Import a saved ChatGPT conversation JSON file into Obsidian."
    )
    parser.add_argument("json_path", help="Path to a saved ChatGPT conversation JSON file.")
    args = parser.parse_args(argv)

    try:
        output = import_json_file(args.json_path)
    except FileNotFoundError as error:
        print(f"Error: {error}", file=sys.stderr)
        return 1
    except JSONDecodeError as error:
        print(f"Error: Failed to parse JSON: {error}", file=sys.stderr)
        return 1
    except OSError as error:
        print(f"Error: Failed to read JSON file: {error}", file=sys.stderr)
        return 1

    print(json.dumps(output, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
