from fastapi.testclient import TestClient

from chatgpt_obsidian_sync.app import create_app


def test_rejects_message_conversation_id_mismatch(sample_config, tmp_path):
    client = TestClient(create_app(sample_config, config_path=tmp_path / "config.json"))

    response = client.post(
        "/api/messages",
        json={
            "conversation_id": "conv-b",
            "title": "Conversation B",
            "messages": [
                {
                    "id": "msg-1",
                    "conversation_id": "conv-a",
                    "role": "user",
                    "content": "This belongs to A",
                    "position": 0,
                }
            ],
        },
    )

    assert response.status_code == 400
    assert response.json() == {
        "ok": False,
        "error": "payload conversation_id mismatch",
        "payload_conversation_id": "conv-b",
        "message_conversation_ids": ["conv-a"],
        "mismatch_count": 1,
    }


def test_rejects_message_id_already_owned_by_another_conversation(sample_config, tmp_path):
    client = TestClient(create_app(sample_config, config_path=tmp_path / "config.json"))
    first = client.post(
        "/api/messages",
        json={
            "conversation_id": "conv-a",
            "title": "Conversation A",
            "messages": [
                {
                    "id": "shared-message-id",
                    "conversation_id": "conv-a",
                    "role": "user",
                    "content": "A text",
                    "position": 0,
                }
            ],
        },
    )

    second = client.post(
        "/api/messages",
        json={
            "conversation_id": "conv-b",
            "title": "Conversation B",
            "messages": [
                {
                    "id": "shared-message-id",
                    "conversation_id": "conv-b",
                    "role": "user",
                    "content": "B text",
                    "position": 0,
                }
            ],
        },
    )

    assert first.status_code == 200
    assert second.status_code == 400
    assert second.json() == {
        "ok": False,
        "error": "message_id already belongs to another conversation",
        "message_id": "shared-message-id",
        "existing_conversation_id": "conv-a",
        "payload_conversation_id": "conv-b",
    }

    conv_b_dir = sample_config.vault_path / "AI" / "_ChatGPTSyncTest" / "Conversation B - conv-b"
    assert not conv_b_dir.exists()


def test_legacy_page_owner_does_not_block_formal_conversation_realtime_upsert(
    sample_config, tmp_path
):
    client = TestClient(create_app(sample_config, config_path=tmp_path / "config.json"))
    message_id = "7013bba4-cd6a-4b8f-8973-33b1dcb92145"
    legacy = client.post(
        "/api/messages",
        json={
            "conversation_id": "page-e4af3c6b",
            "title": "Legacy Page Owner",
            "messages": [
                {
                    "id": message_id,
                    "conversation_id": "page-e4af3c6b",
                    "role": "user",
                    "content": "Legacy polluted text",
                    "position": 0,
                }
            ],
        },
    )

    formal = client.post(
        "/api/messages",
        json={
            "conversation_id": "6a1d98fc-3fec-838f-9b50-474f30391a06",
            "title": "Formal Conversation",
            "messages": [
                {
                    "id": message_id,
                    "conversation_id": "6a1d98fc-3fec-838f-9b50-474f30391a06",
                    "role": "user",
                    "content": "Current formal conversation text",
                    "position": 0,
                }
            ],
        },
    )

    assert legacy.status_code == 200
    assert formal.status_code == 200
    assert "ignored legacy page-* owner conflict" in formal.json()["warnings"]


def test_realtime_fallback_id_is_namespaced_and_not_globally_rejected(sample_config, tmp_path):
    client = TestClient(create_app(sample_config, config_path=tmp_path / "config.json"))
    fallback_a = "realtime:conv-a:user:0:abcdef1234567890"
    fallback_b = "realtime:conv-b:user:0:abcdef1234567890"

    first = client.post(
        "/api/messages",
        json={
            "conversation_id": "conv-a",
            "title": "Conversation A",
            "messages": [
                {
                    "id": fallback_a,
                    "conversation_id": "conv-a",
                    "role": "user",
                    "content": "A text",
                    "position": 0,
                }
            ],
        },
    )
    second = client.post(
        "/api/messages",
        json={
            "conversation_id": "conv-b",
            "title": "Conversation B",
            "messages": [
                {
                    "id": fallback_b,
                    "conversation_id": "conv-b",
                    "role": "user",
                    "content": "B text",
                    "position": 0,
                }
            ],
        },
    )

    assert first.status_code == 200
    assert second.status_code == 200
    assert second.json()["realtime_fallback_message_count"] == 1
    assert second.json()["last_order_warning"]
