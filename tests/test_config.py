import json

from chatgpt_obsidian_sync.config import AppConfig, load_config


def test_load_config_uses_defaults_when_file_is_missing(tmp_path):
    config = load_config(tmp_path / "missing.json")

    assert config.vault_path == AppConfig().vault_path
    assert config.base_dir == "AI/_ChatGPTSyncTest"
    assert config.messages_per_part == 10
    assert config.server_port == 8765
    assert config.database_path.name == "sync.db"


def test_load_config_applies_json_overrides(tmp_path):
    config_path = tmp_path / "config.json"
    config_path.write_text(
        json.dumps(
            {
                "vault_path": str(tmp_path / "My Vault"),
                "base_dir": "Inbox/ChatGPT",
                "messages_per_part": 5,
                "server_port": 9000,
            }
        ),
        encoding="utf-8",
    )

    config = load_config(config_path)

    assert config.vault_path == tmp_path / "My Vault"
    assert config.base_dir == "Inbox/ChatGPT"
    assert config.messages_per_part == 5
    assert config.server_port == 9000
    assert config.database_path == config_path.parent / "sync.db"
