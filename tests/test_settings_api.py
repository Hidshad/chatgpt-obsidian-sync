import json

from fastapi.testclient import TestClient

from chatgpt_obsidian_sync.app import create_app


def test_settings_page_shows_status_and_current_config(sample_config, tmp_path):
    client = TestClient(create_app(sample_config, config_path=tmp_path / "config.json"))

    response = client.get("/")

    assert response.status_code == 200
    assert "ChatGPT Obsidian Sync" in response.text
    assert str(sample_config.vault_path) in response.text
    assert sample_config.base_dir in response.text
    assert "保存设置" in response.text


def test_get_config_reports_vault_state(sample_config, tmp_path):
    client = TestClient(create_app(sample_config, config_path=tmp_path / "config.json"))

    response = client.get("/api/config")

    assert response.status_code == 200
    assert response.json()["ok"] is True
    assert response.json()["config"]["vault_path"] == str(sample_config.vault_path)
    assert response.json()["config"]["base_dir"] == "AI/_ChatGPTSyncTest"
    assert response.json()["vault_exists"] is True


def test_post_config_persists_to_config_json(sample_config, tmp_path):
    config_path = tmp_path / "config.json"
    new_vault = tmp_path / "New Vault"
    new_vault.mkdir()
    client = TestClient(create_app(sample_config, config_path=config_path))

    response = client.post(
        "/api/config",
        json={
            "vault_path": str(new_vault),
            "base_dir": "AI\\_ChatGPTSyncTest",
            "messages_per_part": 7,
            "server_port": 8765,
        },
    )

    assert response.status_code == 200
    assert response.json()["ok"] is True
    saved = json.loads(config_path.read_text(encoding="utf-8"))
    assert saved["vault_path"] == str(new_vault)
    assert saved["base_dir"] == "AI/_ChatGPTSyncTest"
    assert saved["messages_per_part"] == 7


def test_test_write_creates_file_when_vault_exists(sample_config, tmp_path):
    client = TestClient(create_app(sample_config, config_path=tmp_path / "config.json"))

    response = client.post("/api/test-write")

    assert response.status_code == 200
    assert response.json()["ok"] is True
    test_file = response.json()["test_file"]
    assert test_file.endswith("_sync-test.md")


def test_test_write_returns_human_error_when_vault_missing(sample_config, tmp_path):
    missing_config = sample_config.model_copy(update={"vault_path": tmp_path / "Missing Vault"})
    client = TestClient(create_app(missing_config, config_path=tmp_path / "config.json"))

    response = client.post("/api/test-write")

    assert response.status_code == 400
    assert response.json() == {
        "ok": False,
        "error": "Vault 路径不存在，请先在设置页选择 Obsidian Vault 文件夹。",
    }
