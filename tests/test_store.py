from chatgpt_obsidian_sync.schemas import MessageIn
from chatgpt_obsidian_sync.store import SQLiteStore


def test_save_messages_inserts_conversation_and_skips_duplicates(sample_config):
    store = SQLiteStore(sample_config.database_path)
    store.initialize()

    messages = [
        MessageIn(id="m1", role="user", content="Hello", position=0),
        MessageIn(id="m2", role="assistant", content="Hi", position=1),
    ]

    first = store.save_messages("conv-1", "A Test Chat", messages)
    second = store.save_messages("conv-1", "A Test Chat", messages)

    assert first.saved == 2
    assert first.skipped == 0
    assert second.saved == 0
    assert second.skipped == 2
    assert store.list_messages("conv-1") == [
        {"id": "m1", "role": "user", "content": "Hello", "position": 0},
        {"id": "m2", "role": "assistant", "content": "Hi", "position": 1},
    ]
    assert store.get_conversation("conv-1")["title"] == "A Test Chat"


def test_save_messages_updates_message_content_for_existing_id(sample_config):
    store = SQLiteStore(sample_config.database_path)
    store.initialize()

    store.save_messages(
        "conv-1",
        "Old Title",
        [MessageIn(id="m1", role="user", content="Draft", position=0)],
    )
    result = store.save_messages(
        "conv-1",
        "New Title",
        [MessageIn(id="m1", role="user", content="Final", position=0)],
    )

    assert result.saved == 0
    assert result.updated == 1
    assert result.skipped == 0
    assert store.list_messages("conv-1")[0]["content"] == "Final"
    assert store.get_conversation("conv-1")["title"] == "Old Title"


def test_realtime_updates_do_not_reorder_existing_messages_and_append_fallback(sample_config):
    store = SQLiteStore(sample_config.database_path)
    store.initialize()
    store.save_messages(
        "conv-order",
        "Order",
        [
            MessageIn(id="m1", role="user", content="One", position=0),
            MessageIn(id="m2", role="assistant", content="Two", position=1),
        ],
    )

    store.save_messages(
        "conv-order",
        "Order",
        [
            MessageIn(id="m1", role="user", content="One updated", position=99),
            MessageIn(
                id="realtime:conv-order:assistant:0:abc",
                role="assistant",
                content="Fallback",
                position=0,
            ),
        ],
    )

    assert store.list_messages("conv-order") == [
        {"id": "m1", "role": "user", "content": "One updated", "position": 0},
        {"id": "m2", "role": "assistant", "content": "Two", "position": 1},
        {
            "id": "realtime:conv-order:assistant:0:abc",
            "role": "assistant",
            "content": "Fallback",
            "position": 2,
        },
    ]


def test_realtime_append_mode_adds_new_messages_after_current_max_order(sample_config):
    store = SQLiteStore(sample_config.database_path)
    store.initialize()
    store.save_messages(
        "conv-append",
        "Append",
        [
            MessageIn(id=f"m{i}", role="user", content=f"Full {i}", position=i)
            for i in range(3)
        ],
    )

    result = store.save_messages(
        "conv-append",
        "Append",
        [
            MessageIn(id="m1", role="user", content="Full 1 updated", position=99),
            MessageIn(id="dom-new-1", role="user", content="现在我在测试同步功能，test", position=0),
            MessageIn(id="dom-new-2", role="assistant", content="收到 test", position=1),
        ],
        append_new_messages=True,
    )

    assert result.inserted == 2
    assert result.updated == 1
    assert result.skipped == 0
    assert result.max_order_index_before == 2
    assert result.max_order_index_after == 4
    assert result.updated_order_indexes == [1]
    assert result.inserted_order_indexes == [3, 4]
    assert result.inserted_message_ids == ["dom-new-1", "dom-new-2"]
    assert store.list_messages("conv-append") == [
        {"id": "m0", "role": "user", "content": "Full 0", "position": 0},
        {"id": "m1", "role": "user", "content": "Full 1 updated", "position": 1},
        {"id": "m2", "role": "user", "content": "Full 2", "position": 2},
        {
            "id": "dom-new-1",
            "role": "user",
            "content": "现在我在测试同步功能，test",
            "position": 3,
        },
        {"id": "dom-new-2", "role": "assistant", "content": "收到 test", "position": 4},
    ]


def test_realtime_fallback_with_identical_text_is_skipped_without_reordering(sample_config):
    store = SQLiteStore(sample_config.database_path)
    store.initialize()
    store.save_messages(
        "conv-dupe-text",
        "Dupe",
        [MessageIn(id="m1", role="user", content="Same visible text", position=0)],
    )

    result = store.save_messages(
        "conv-dupe-text",
        "Dupe",
        [
            MessageIn(
                id="realtime:conv-dupe-text:user:9:abcdef",
                role="user",
                content="Same visible text",
                position=9,
            )
        ],
        append_new_messages=True,
    )

    assert result.inserted == 0
    assert result.updated == 0
    assert result.skipped == 1
    assert result.skipped_message_ids_tail == ["realtime:conv-dupe-text:user:9:abcdef"]
    assert store.list_messages("conv-dupe-text") == [
        {"id": "m1", "role": "user", "content": "Same visible text", "position": 0}
    ]


def test_normalize_conversation_order_repairs_gaps_and_duplicates_without_losing_messages(
    sample_config,
):
    store = SQLiteStore(sample_config.database_path)
    store.initialize()
    store.save_messages(
        "conv-normalize",
        "Normalize",
        [
            MessageIn(id="m0", role="user", content="First", position=0),
            MessageIn(id="m2a", role="assistant", content="Second-ish", position=2),
            MessageIn(id="m2b", role="user", content="Third-ish", position=2),
        ],
    )

    before = store.conversation_order_diagnostics("conv-normalize", messages_per_part=10)
    store.normalize_conversation_order("conv-normalize")
    after = store.conversation_order_diagnostics("conv-normalize", messages_per_part=10)

    assert before["missing_order_index_count"] == 1
    assert before["duplicate_order_index_count"] == 1
    assert after["missing_order_index_count"] == 0
    assert after["duplicate_order_index_count"] == 0
    assert after["order_gap_count"] == 0
    assert store.list_messages("conv-normalize") == [
        {"id": "m0", "role": "user", "content": "First", "position": 0},
        {"id": "m2a", "role": "assistant", "content": "Second-ish", "position": 1},
        {"id": "m2b", "role": "user", "content": "Third-ish", "position": 2},
    ]
