from pathlib import Path

import pytest


@pytest.fixture
def sample_config(tmp_path: Path):
    from chatgpt_obsidian_sync.config import AppConfig

    vault_path = tmp_path / "Vault"
    vault_path.mkdir()
    return AppConfig(
        vault_path=vault_path,
        base_dir="AI/_ChatGPTSyncTest",
        messages_per_part=10,
        server_port=8765,
        database_path=tmp_path / "sync.db",
    )
