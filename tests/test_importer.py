from chatgpt_obsidian_sync.importer import parse_conversation_json


def test_parse_conversation_json_follows_main_chain_and_filters_messages():
    conversation = {
        "conversation_id": "conv-full",
        "title": "Full History",
        "mapping": {
            "client-created-root": {
                "id": "client-created-root",
                "message": None,
                "children": ["empty-node"],
            },
            "empty-node": {
                "id": "empty-node",
                "message": None,
                "children": ["user-1"],
            },
            "user-1": {
                "id": "user-1",
                "message": {
                    "id": "msg-user-1",
                    "author": {"role": "user"},
                    "content": {
                        "content_type": "text",
                        "parts": ["第一段\n\n- 列表"],
                    },
                },
                "children": ["tool-context", "side-branch"],
            },
            "side-branch": {
                "id": "side-branch",
                "message": {
                    "id": "msg-side",
                    "author": {"role": "assistant"},
                    "content": {"content_type": "text", "parts": ["not main chain"]},
                },
                "children": [],
            },
            "tool-context": {
                "id": "tool-context",
                "message": {
                    "id": "msg-context",
                    "author": {"role": "system"},
                    "content": {
                        "content_type": "model_editable_context",
                        "parts": ["skip me"],
                    },
                },
                "children": ["assistant-1"],
            },
            "assistant-1": {
                "id": "assistant-1",
                "message": {
                    "id": "msg-assistant-1",
                    "author": {"role": "assistant"},
                    "content": {
                        "content_type": "text",
                        "parts": ["```python\n", "print('hi')\n```"],
                    },
                },
                "children": [],
            },
        },
    }

    parsed = parse_conversation_json(conversation)

    assert parsed.conversation_id == "conv-full"
    assert parsed.title == "Full History"
    assert [message.id for message in parsed.messages] == [
        "msg-user-1",
        "msg-assistant-1",
    ]
    assert parsed.messages[0].role == "user"
    assert parsed.messages[0].content == "第一段\n\n- 列表"
    assert parsed.messages[0].position == 0
    assert parsed.messages[1].role == "assistant"
    assert parsed.messages[1].content == "```python\nprint('hi')\n```"
    assert parsed.messages[1].position == 1


def test_parse_conversation_json_uses_parentless_root_when_client_root_is_missing():
    conversation = {
        "conversation_id": "conv-rootless",
        "title": "Rootless Export",
        "mapping": {
            "root-node": {
                "id": "root-node",
                "parent": None,
                "message": None,
                "children": ["user-1"],
            },
            "user-1": {
                "id": "user-1",
                "parent": "root-node",
                "message": {
                    "id": "msg-user-1",
                    "author": {"role": "user"},
                    "content": {"content_type": "text", "parts": ["Hello"]},
                },
                "children": ["assistant-1"],
            },
            "assistant-1": {
                "id": "assistant-1",
                "parent": "user-1",
                "message": {
                    "id": "msg-assistant-1",
                    "author": {"role": "assistant"},
                    "content": {"content_type": "text", "parts": ["Hi"]},
                },
                "children": [],
            },
        },
    }

    parsed = parse_conversation_json(conversation)

    assert [message.id for message in parsed.messages] == [
        "msg-user-1",
        "msg-assistant-1",
    ]
    assert [message.position for message in parsed.messages] == [0, 1]


def test_parse_conversation_json_prefers_current_node_parent_chain():
    mapping = {
        "client-created-root": {"message": None, "children": ["old-user", "new-user"]},
        "old-user": {
            "parent": "client-created-root",
            "message": {
                "id": "old-user-message",
                "author": {"role": "user"},
                "content": {"content_type": "text", "parts": ["old branch"]},
            },
            "children": ["old-assistant"],
        },
        "old-assistant": {
            "parent": "old-user",
            "message": {
                "id": "old-assistant-message",
                "author": {"role": "assistant"},
                "content": {"content_type": "text", "parts": ["old answer"]},
            },
            "children": [],
        },
        "new-user": {
            "parent": "client-created-root",
            "message": {
                "id": "new-user-message",
                "author": {"role": "user"},
                "content": {"content_type": "text", "parts": ["current branch"]},
            },
            "children": ["new-assistant"],
        },
        "new-assistant": {
            "parent": "new-user",
            "message": {
                "id": "new-assistant-message",
                "author": {"role": "assistant"},
                "content": {"content_type": "text", "parts": ["current answer"]},
            },
            "children": [],
        },
    }

    parsed = parse_conversation_json(
        {
            "conversation_id": "conv-current",
            "title": "Current Branch",
            "current_node": "new-assistant",
            "mapping": mapping,
        }
    )

    assert [message.id for message in parsed.messages] == [
        "new-user-message",
        "new-assistant-message",
    ]
    assert parsed.diagnostics["used_current_node"] is True
    assert parsed.diagnostics["branched_node_count"] >= 1


def test_parse_conversation_json_marks_suspect_when_main_chain_is_too_small():
    mapping = {
        "client-created-root": {"message": None, "children": ["u0"]},
    }
    for index in range(60):
        node_id = f"u{index}"
        mapping[node_id] = {
            "parent": "client-created-root",
            "message": {
                "id": f"message-{index}",
                "author": {"role": "user"},
                "content": {"content_type": "text", "parts": [f"message {index}"]},
            },
            "children": [],
        }

    parsed = parse_conversation_json(
        {
            "conversation_id": "conv-suspect",
            "title": "Suspect",
            "current_node": "u0",
            "mapping": mapping,
        }
    )

    assert len(parsed.messages) == 1
    assert parsed.diagnostics["mapping_node_count"] == 61
    assert parsed.diagnostics["candidate_message_node_count"] == 60
    assert parsed.diagnostics["full_snapshot_quality"] == "suspect"
    assert "parsed messages much fewer than candidate message nodes" in parsed.diagnostics["warnings"]
