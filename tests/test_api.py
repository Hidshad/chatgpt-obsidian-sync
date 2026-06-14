from fastapi.testclient import TestClient

from chatgpt_obsidian_sync.app import create_app


def test_health_returns_ok(sample_config):
    client = TestClient(create_app(sample_config))

    response = client.get("/health")

    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_post_messages_saves_and_exports(sample_config):
    client = TestClient(create_app(sample_config))

    payload = {
        "conversation_id": "conv-web",
        "title": "Browser Chat",
        "messages": [
            {"id": "u1", "role": "user", "content": "Hello", "position": 0},
            {"id": "a1", "role": "assistant", "content": "Hi there", "position": 1},
        ],
    }

    response = client.post("/api/messages", json=payload)
    duplicate = client.post("/api/messages", json=payload)

    assert response.status_code == 200
    data = response.json()
    duplicate_data = duplicate.json()
    assert data["ok"] is True
    assert data["received_messages"] == 2
    assert data["inserted_messages"] == 2
    assert data["updated_messages"] == 0
    assert data["skipped_messages"] == 0
    assert data["message_count_after"] == 2
    assert data["export_attempted"] is True
    assert data["exported"] is True
    assert data["output_folder"].endswith("Browser Chat - conv-web")
    assert data["updated_files"] == ["part-001.md", "index.md"]
    assert data["export_error"] is None
    assert data["saved"] == 2
    assert duplicate_data["saved"] == 0
    assert duplicate_data["inserted_messages"] == 0
    assert duplicate_data["updated_messages"] == 0
    assert duplicate_data["skipped_messages"] == 2
    assert duplicate_data["export_attempted"] is False
    assert duplicate_data["exported"] is False
    part = sample_config.vault_path / "AI" / "_ChatGPTSyncTest" / "Browser Chat - conv-web" / "part-001.md"
    assert part.exists()
    markdown = part.read_text(encoding="utf-8")
    assert "## 🧑 User\n\nHello" in markdown
    assert "## 🤖 Assistant\n\nHi there" in markdown
    assert "> [!tip]" not in markdown
    assert "> [!note]" not in markdown


def test_post_messages_reports_updates_and_reexports(sample_config):
    client = TestClient(create_app(sample_config))
    base_payload = {
        "conversation_id": "conv-update-export",
        "title": "Update Export",
        "messages": [
            {"message_id": "m1", "role": "user", "text": "Before", "order_index": 0}
        ],
    }
    client.post("/api/messages", json=base_payload)

    response = client.post(
        "/api/messages",
        json={
            **base_payload,
            "messages": [
                {"message_id": "m1", "role": "user", "text": "After", "order_index": 0}
            ],
        },
    )

    data = response.json()
    assert response.status_code == 200
    assert data["inserted_messages"] == 0
    assert data["updated_messages"] == 1
    assert data["skipped_messages"] == 0
    assert data["message_count_after"] == 1
    assert data["export_attempted"] is True
    assert data["exported"] is True
    assert "part-001.md" in data["updated_files"]
    part = sample_config.vault_path / "AI" / "_ChatGPTSyncTest" / "Update Export - conv-update-export" / "part-001.md"
    assert "After" in part.read_text(encoding="utf-8")


def test_realtime_messages_append_after_full_snapshot_and_return_order_diagnostics(sample_config):
    client = TestClient(create_app(sample_config))
    client.post(
        "/api/messages",
        json={
            "conversation_id": "conv-realtime-append",
            "title": "Realtime Append",
            "messages": [
                {"message_id": f"full-{i}", "role": "user", "text": f"Full {i}", "order_index": i}
                for i in range(3)
            ],
        },
    )

    response = client.post(
        "/api/messages",
        json={
            "conversation_id": "conv-realtime-append",
            "title": "Realtime Append",
            "source": "extension-content-realtime",
            "is_partial_snapshot": True,
            "messages": [
                {
                    "message_id": "full-1",
                    "role": "user",
                    "text": "Full 1 updated",
                    "order_index": 99,
                },
                {
                    "message_id": "realtime:conv-realtime-append:user:0:testhash",
                    "role": "user",
                    "text": "现在我在测试同步功能，test",
                    "order_index": 0,
                },
            ],
        },
    )

    data = response.json()
    assert response.status_code == 200
    assert data["inserted_messages"] == 1
    assert data["updated_messages"] == 1
    assert data["skipped_messages"] == 0
    assert data["max_order_index_before"] == 2
    assert data["max_order_index_after"] == 3
    assert data["updated_order_indexes"] == [1]
    assert data["inserted_order_indexes"] == [3]
    assert data["inserted_message_ids"] == ["realtime:conv-realtime-append:user:0:testhash"]
    assert data["inserted_tail"] == [
        {"role": "user", "order_index": 3, "preview": "现在我在测试同步功能，test"}
    ]
    assert data["last_successful_export_updated_files"]
    assert data["last_successful_export_last_role"] == "user"
    assert data["last_successful_export_last_text_preview"] == "现在我在测试同步功能，test"
    assert data["last_successful_export_last_order_index"] == 3
    assert data["last_successful_export_last_part_filename"] == "part-001.md"
    part = (
        sample_config.vault_path
        / "AI"
        / "_ChatGPTSyncTest"
        / "Realtime Append - conv-realtime-append"
        / "part-001.md"
    )
    markdown = part.read_text(encoding="utf-8")
    assert markdown.index("Full 2") < markdown.index("现在我在测试同步功能，test")

    duplicate = client.post(
        "/api/messages",
        json={
            "conversation_id": "conv-realtime-append",
            "title": "Realtime Append",
            "source": "extension-content-realtime",
            "is_partial_snapshot": True,
            "messages": [
                {
                    "message_id": "realtime:conv-realtime-append:user:0:testhash",
                    "role": "user",
                    "text": "现在我在测试同步功能，test",
                    "order_index": 0,
                }
            ],
        },
    ).json()
    assert duplicate["inserted_messages"] == 0
    assert duplicate["export_attempted"] is False
    assert duplicate["last_successful_export_updated_files"] == []


def test_post_messages_reports_export_failure_without_losing_database_update(
    sample_config, monkeypatch
):
    import chatgpt_obsidian_sync.app as app_module

    def fail_export(*_args, **_kwargs):
        raise PermissionError("locked by OneDrive")

    monkeypatch.setattr(app_module, "export_conversation", fail_export)
    client = TestClient(app_module.create_app(sample_config))

    response = client.post(
        "/api/messages",
        json={
            "conversation_id": "conv-export-fail",
            "title": "Export Fail",
            "messages": [
                {"message_id": "m1", "role": "user", "text": "Saved in DB", "order_index": 0}
            ],
        },
    )
    status = client.get("/api/conversation/status", params={"conversation_id": "conv-export-fail"})

    data = response.json()
    assert response.status_code == 200
    assert data["ok"] is True
    assert data["inserted_messages"] == 1
    assert data["message_count_after"] == 1
    assert data["export_attempted"] is True
    assert data["exported"] is False
    assert data["updated_files"] == []
    assert "locked by OneDrive" in data["export_error"]
    assert "database updated but markdown export failed" in data["warnings"]
    assert status.json()["message_count"] == 1


def test_regenerate_conversation_export_uses_database_only(sample_config):
    client = TestClient(create_app(sample_config))
    client.post(
        "/api/messages",
        json={
            "conversation_id": "conv-regenerate",
            "title": "Regenerate",
            "messages": [
                {"message_id": "m1", "role": "user", "text": "From DB", "order_index": 0}
            ],
        },
    )
    part = sample_config.vault_path / "AI" / "_ChatGPTSyncTest" / "Regenerate - conv-regenerate" / "part-001.md"
    part.unlink()

    response = client.post("/api/conversation/export", json={"conversation_id": "conv-regenerate"})

    data = response.json()
    assert response.status_code == 200
    assert data["ok"] is True
    assert data["exported"] is True
    assert "part-001.md" in data["updated_files"]
    assert data["exported_section_count"] == 1
    assert data["part_count"] == 1
    assert data["last_exported_text_preview"] == "From DB"
    assert "From DB" in part.read_text(encoding="utf-8")


def test_regenerate_conversation_export_normalizes_order_before_export(sample_config):
    client = TestClient(create_app(sample_config))
    client.post(
        "/api/messages",
        json={
            "conversation_id": "conv-regenerate-normalize",
            "title": "Regenerate Normalize",
            "source": "unit-test",
            "messages": [
                {"message_id": "m0", "role": "user", "text": "First", "order_index": 0},
                {"message_id": "m2", "role": "assistant", "text": "Last", "order_index": 2},
            ],
        },
    )
    before = client.get(
        "/api/conversation/status", params={"conversation_id": "conv-regenerate-normalize"}
    ).json()

    response = client.post(
        "/api/conversation/export", json={"conversation_id": "conv-regenerate-normalize"}
    )
    after = client.get(
        "/api/conversation/status", params={"conversation_id": "conv-regenerate-normalize"}
    ).json()

    assert before["order_gap_count"] == 1
    assert response.status_code == 200
    assert response.json()["order_gap_count"] == 0
    assert after["missing_order_index_count"] == 0
    assert after["duplicate_order_index_count"] == 0
    assert after["order_gap_count"] == 0


def test_conversation_status_returns_order_and_export_diagnostics(sample_config):
    client = TestClient(create_app(sample_config))
    client.post(
        "/api/messages",
        json={
            "conversation_id": "conv-status-order",
            "title": "Status Order",
            "source": "unit-test",
            "messages": [
                {"message_id": "m0", "role": "user", "text": "First", "order_index": 0},
                {"message_id": "m2", "role": "assistant", "text": "Last", "order_index": 2},
            ],
        },
    )

    response = client.get(
        "/api/conversation/status", params={"conversation_id": "conv-status-order"}
    )
    data = response.json()

    assert response.status_code == 200
    assert data["db_message_count"] == 2
    assert data["exported_section_count"] == 2
    assert data["part_count"] == 1
    assert data["index_link_count"] == 1
    assert data["first_order_index"] == 0
    assert data["last_order_index"] == 2
    assert data["missing_order_index_count"] == 1
    assert data["duplicate_order_index_count"] == 0
    assert data["order_gap_count"] == 1
    assert data["last_exported_text_preview"] == "Last"


def test_status_returns_canonical_output_folder_and_realtime_does_not_rename(sample_config):
    client = TestClient(create_app(sample_config))
    client.post(
        "/api/messages",
        json={
            "conversation_id": "conv-canonical",
            "title": "Original Title",
            "messages": [
                {"message_id": "m1", "role": "user", "text": "One", "order_index": 0}
            ],
        },
    )
    client.post(
        "/api/messages",
        json={
            "conversation_id": "conv-canonical",
            "title": "conv-canonical",
            "messages": [
                {"message_id": "m2", "role": "assistant", "text": "Two", "order_index": 1}
            ],
        },
    )

    status = client.get("/api/conversation/status", params={"conversation_id": "conv-canonical"})
    data = status.json()
    assert data["output_folder"].endswith("Original Title - conv-canonical")
    assert (
        sample_config.vault_path
        / "AI"
        / "_ChatGPTSyncTest"
        / "Original Title - conv-canonical"
        / "part-001.md"
    ).exists()
    assert not (
        sample_config.vault_path
        / "AI"
        / "_ChatGPTSyncTest"
        / "conv-canonical - conv-canonical"
    ).exists()


def test_conversation_status_for_missing_conversation(sample_config):
    client = TestClient(create_app(sample_config))

    response = client.get("/api/conversation/status", params={"conversation_id": "missing"})

    assert response.status_code == 200
    data = response.json()
    assert data["ok"] is True
    assert data["conversation_id"] == "missing"
    assert data["exists"] is False
    assert data["has_full_snapshot"] is False
    assert data["message_count"] == 0
    assert data["last_full_export_at"] is None
    assert data["last_realtime_sync_at"] is None
    assert data["needs_recalibration"] is True
    assert data["reason"] == "no_full_snapshot"


def test_full_import_marks_full_snapshot_and_updates_status(sample_config):
    client = TestClient(create_app(sample_config))
    payload = {
        "conversation_id": "conv-status",
        "title": "Status Import",
        "mapping": {
            "client-created-root": {"message": None, "children": ["u1"]},
            "u1": {
                "message": {
                    "id": "u1",
                    "author": {"role": "user"},
                    "content": {"content_type": "text", "parts": ["Hello"]},
                },
                "children": [],
            },
        },
    }

    imported = client.post("/api/conversation/import", json=payload)
    status = client.get("/api/conversation/status", params={"conversation_id": "conv-status"})

    assert imported.status_code == 200
    data = status.json()
    assert data["exists"] is True
    assert data["has_full_snapshot"] is True
    assert data["message_count"] == 1
    assert data["last_full_export_at"] is not None
    assert data["needs_recalibration"] is False
    assert data["reason"] == ""
    imported_data = imported.json()
    assert imported_data["parsed_message_count"] == 1
    assert imported_data["has_full_snapshot"] is True
    assert imported_data["full_snapshot_quality"] == "ok"


def test_suspect_full_import_does_not_mark_full_snapshot(sample_config):
    client = TestClient(create_app(sample_config))
    mapping = {
        "client-created-root": {"message": None, "children": ["m000"]},
    }
    for index in range(60):
        mapping[f"m{index:03d}"] = {
            "parent": "client-created-root",
            "message": {
                "id": f"message-{index}",
                "author": {"role": "user"},
                "content": {"content_type": "text", "parts": [f"message {index}"]},
            },
            "children": [],
        }

    response = client.post(
        "/api/conversation/import",
        json={
            "conversation_id": "conv-suspect-full",
            "title": "Suspect Full",
            "current_node": "m000",
            "mapping": mapping,
        },
    )
    status = client.get(
        "/api/conversation/status", params={"conversation_id": "conv-suspect-full"}
    )

    assert response.status_code == 400
    data = response.json()
    assert data["ok"] is False
    assert data["error"] == "full snapshot appears incomplete"
    assert data["parsed_message_count"] == 1
    assert data["mapping_node_count"] == 61
    assert data["candidate_message_node_count"] == 60
    assert data["full_snapshot_quality"] == "suspect"
    assert data["has_full_snapshot"] is False
    assert status.json()["has_full_snapshot"] is False
    assert status.json()["full_snapshot_quality"] == "suspect"


def test_partial_realtime_sync_never_marks_full_snapshot(sample_config):
    client = TestClient(create_app(sample_config))

    saved = client.post(
        "/api/messages",
        json={
            "conversation_id": "conv-partial-only",
            "title": "Partial Only",
            "source": "extension-content-realtime",
            "is_partial_snapshot": True,
            "messages": [
                {"message_id": "visible-1", "role": "user", "text": "Visible only", "order_index": 0}
            ],
        },
    )
    status = client.get(
        "/api/conversation/status", params={"conversation_id": "conv-partial-only"}
    )

    assert saved.status_code == 200
    assert saved.json()["source"] == "extension-content-realtime"
    assert saved.json()["is_partial_snapshot"] is True
    data = status.json()
    assert data["exists"] is True
    assert data["has_full_snapshot"] is False
    assert data["message_count"] == 1
    assert data["last_full_export_at"] is None
    assert data["last_realtime_sync_at"] is not None
    assert data["needs_recalibration"] is True
    assert data["reason"] == "no_full_snapshot"


def test_realtime_sync_updates_realtime_timestamp_without_clearing_full_snapshot(sample_config):
    client = TestClient(create_app(sample_config))
    client.post(
        "/api/conversation/import",
        json={
            "conversation_id": "conv-realtime-status",
            "title": "Realtime Status",
            "mapping": {
                "client-created-root": {"message": None, "children": ["u1"]},
                "u1": {
                    "message": {
                        "id": "u1",
                        "author": {"role": "user"},
                        "content": {"content_type": "text", "parts": ["Hello"]},
                    },
                    "children": [],
                },
            },
        },
    )

    saved = client.post(
        "/api/messages",
        json={
            "conversation_id": "conv-realtime-status",
            "title": "Realtime Status",
            "source": "extension-content-realtime",
            "messages": [
                {"message_id": "a1", "role": "assistant", "text": "Hi", "order_index": 1}
            ],
        },
    )
    status = client.get(
        "/api/conversation/status", params={"conversation_id": "conv-realtime-status"}
    )

    assert saved.status_code == 200
    data = status.json()
    assert data["has_full_snapshot"] is True
    assert data["last_realtime_sync_at"] is not None
    assert data["message_count"] == 2


def test_messages_missing_conversation_id_returns_payload_mismatch(sample_config):
    client = TestClient(create_app(sample_config))

    response = client.post(
        "/api/messages",
        json={
            "title": "Missing Conversation",
            "messages": [
                {"message_id": "m1", "role": "user", "text": "Hello", "order_index": 0}
            ],
        },
    )

    assert response.status_code == 400
    assert response.json() == {
        "ok": False,
        "error": "payload conversation_id mismatch",
        "payload_conversation_id": "",
        "message_conversation_ids": [],
        "mismatch_count": 0,
    }


def test_long_full_snapshot_then_realtime_existing_messages_upsert(sample_config):
    client = TestClient(create_app(sample_config))
    conversation_id = "conv-long-realtime"
    mapping = {"client-created-root": {"message": None, "children": ["m000"]}}
    for index in range(284):
        message_id = f"m{index:03d}"
        next_id = f"m{index + 1:03d}" if index < 283 else ""
        mapping[message_id] = {
            "message": {
                "id": message_id,
                "author": {"role": "user" if index % 2 == 0 else "assistant"},
                "content": {
                    "content_type": "text",
                    "parts": [f"Full message {index}"],
                },
            },
            "children": [next_id] if next_id else [],
        }

    imported = client.post(
        "/api/conversation/import",
        json={
            "conversation_id": conversation_id,
            "title": "Long Realtime",
            "mapping": mapping,
        },
    )
    realtime = client.post(
        "/api/messages",
        json={
            "conversation_id": conversation_id,
            "title": "Long Realtime",
            "source": "extension-content-realtime",
            "is_partial_snapshot": True,
            "messages": [
                {
                    "message_id": f"m{index:03d}",
                    "conversation_id": conversation_id,
                    "role": "user" if index % 2 == 0 else "assistant",
                    "text": f"Realtime updated {index}",
                    "order_index": index,
                }
                for index in range(10)
            ],
        },
    )

    assert imported.status_code == 200
    assert realtime.status_code == 200
    assert realtime.json()["saved"] == 0
    assert realtime.json()["updated_messages"] == 10
    assert realtime.json()["skipped"] == 0
    status = client.get("/api/conversation/status", params={"conversation_id": conversation_id})
    assert status.json()["has_full_snapshot"] is True
    assert status.json()["message_count"] == 284


def test_stale_full_snapshot_needs_recalibration(sample_config):
    client = TestClient(create_app(sample_config))
    client.post(
        "/api/conversation/import",
        json={
            "conversation_id": "conv-stale",
            "title": "Stale",
            "mapping": {
                "client-created-root": {"message": None, "children": ["u1"]},
                "u1": {
                    "message": {
                        "id": "u1",
                        "author": {"role": "user"},
                        "content": {"content_type": "text", "parts": ["Hello"]},
                    },
                    "children": [],
                },
            },
        },
    )
    import sqlite3

    with sqlite3.connect(sample_config.database_path) as connection:
      connection.execute(
          "UPDATE conversations SET last_full_export_at = datetime('now', '-7 hours') WHERE id = ?",
          ("conv-stale",),
      )

    status = client.get("/api/conversation/status", params={"conversation_id": "conv-stale"})

    assert status.json()["needs_recalibration"] is True
    assert status.json()["reason"] == "full_snapshot_stale"


def test_realtime_message_sync_does_not_delete_previous_history(sample_config):
    client = TestClient(create_app(sample_config))
    initial_messages = [
        {
            "message_id": f"msg-{index:03d}",
            "role": "user" if index % 2 == 0 else "assistant",
            "text": f"Message {index}",
            "order_index": index,
        }
        for index in range(25)
    ]

    first = client.post(
        "/api/messages",
        json={
            "conversation_id": "conv-realtime-safe",
            "title": "Realtime Safe",
            "source": "extension-content-realtime",
            "messages": initial_messages,
        },
    )
    second = client.post(
        "/api/messages",
        json={
            "conversation_id": "conv-realtime-safe",
            "title": "Realtime Safe",
            "source": "extension-content-realtime",
            "messages": initial_messages[:5],
        },
    )

    assert first.status_code == 200
    assert second.status_code == 200
    conversation_dir = (
        sample_config.vault_path
        / "AI"
        / "_ChatGPTSyncTest"
        / "Realtime Safe - conv-realtime-safe"
    )
    part_files = sorted(conversation_dir.glob("part-*.md"))
    assert [part.name for part in part_files] == [
        "part-001.md",
        "part-002.md",
        "part-003.md",
    ]
    assert "Message 24" in (conversation_dir / "part-003.md").read_text(encoding="utf-8")


def test_import_conversation_upserts_main_chain_and_rewrites_export(sample_config):
    client = TestClient(create_app(sample_config))
    payload = {
        "conversation_id": "conv-full",
        "title": "Full Import",
        "mapping": {
            "client-created-root": {
                "message": None,
                "children": ["user-1"],
            },
            "user-1": {
                "message": {
                    "id": "msg-user-1",
                    "author": {"role": "user"},
                    "content": {"content_type": "text", "parts": ["Hello"]},
                },
                "children": ["assistant-1"],
            },
            "assistant-1": {
                "message": {
                    "id": "msg-assistant-1",
                    "author": {"role": "assistant"},
                    "content": {"content_type": "text", "parts": ["Hi"]},
                },
                "children": [],
            },
        },
    }

    first = client.post("/api/conversation/import", json=payload)
    second = client.post("/api/conversation/import", json=payload)
    payload["mapping"]["assistant-1"]["message"]["content"]["parts"] = ["Hi updated"]
    third = client.post("/api/conversation/import", json=payload)

    assert first.status_code == 200
    assert first.json()["imported_messages"] == 2
    assert first.json()["updated_messages"] == 0
    assert first.json()["skipped_messages"] == 0
    assert first.json()["output_folder"].endswith("Full Import - conv-full")
    assert second.json()["imported_messages"] == 0
    assert second.json()["updated_messages"] == 0
    assert second.json()["skipped_messages"] == 2
    assert third.json()["imported_messages"] == 0
    assert third.json()["updated_messages"] == 1
    assert third.json()["skipped_messages"] == 1

    part = sample_config.vault_path / "AI" / "_ChatGPTSyncTest" / "Full Import - conv-full" / "part-001.md"
    markdown = part.read_text(encoding="utf-8")
    assert markdown == "## 🧑 User\n\nHello\n\n---\n\n## 🤖 Assistant\n\nHi updated\n"


def test_full_calibration_merges_without_deleting_realtime_messages(sample_config):
    client = TestClient(create_app(sample_config))
    client.post(
        "/api/messages",
        json={
            "conversation_id": "conv-mixed",
            "title": "Mixed Source",
            "messages": [
                {
                    "id": "dom-0-user-old",
                    "role": "user",
                    "content": "DOM duplicate",
                    "position": 0,
                }
            ],
        },
    )

    response = client.post(
        "/api/conversation/import",
        json={
            "conversation_id": "conv-mixed",
            "title": "Mixed Source",
            "mapping": {
                "client-created-root": {"message": None, "children": ["user-1"]},
                "user-1": {
                    "message": {
                        "id": "official-user-1",
                        "author": {"role": "user"},
                        "content": {"content_type": "text", "parts": ["Official text"]},
                    },
                    "children": [],
                },
            },
        },
    )

    assert response.status_code == 200
    part = sample_config.vault_path / "AI" / "_ChatGPTSyncTest" / "Mixed Source - conv-mixed" / "part-001.md"
    markdown = part.read_text(encoding="utf-8")
    assert "Official text" in markdown
    assert "DOM duplicate" in markdown


def test_full_calibration_fills_cross_device_gap_and_reorders(sample_config):
    client = TestClient(create_app(sample_config))
    realtime_messages = [
        {"message_id": f"m{i:03d}", "role": "user", "text": f"Message {i}", "order_index": i}
        for i in [0, 1, 2, 5]
    ]
    client.post(
        "/api/messages",
        json={
            "conversation_id": "conv-cross-device",
            "title": "Cross Device",
            "source": "extension-content-realtime",
            "messages": realtime_messages,
        },
    )

    mapping = {"client-created-root": {"message": None, "children": ["m000"]}}
    for i in range(6):
        node_id = f"m{i:03d}"
        next_id = f"m{i + 1:03d}" if i < 5 else None
        mapping[node_id] = {
            "message": {
                "id": node_id,
                "author": {"role": "user" if i % 2 == 0 else "assistant"},
                "content": {"content_type": "text", "parts": [f"Message {i}"]},
            },
            "children": [next_id] if next_id else [],
        }

    response = client.post(
        "/api/conversation/import",
        json={
            "conversation_id": "conv-cross-device",
            "title": "Cross Device",
            "mapping": mapping,
        },
    )

    assert response.status_code == 200
    part = (
        sample_config.vault_path
        / "AI"
        / "_ChatGPTSyncTest"
        / "Cross Device - conv-cross-device"
        / "part-001.md"
    )
    markdown = part.read_text(encoding="utf-8")
    positions = [markdown.index(f"Message {i}") for i in range(6)]
    assert positions == sorted(positions)
