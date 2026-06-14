from pathlib import Path

from chatgpt_obsidian_sync.exporter import (
    export_conversation,
    render_message_section,
    safe_path_segment,
    safe_replace,
)
from chatgpt_obsidian_sync.schemas import MessageIn
from chatgpt_obsidian_sync.store import SQLiteStore


def test_safe_path_segment_removes_windows_reserved_characters():
    assert safe_path_segment('Bad:/Name*?"<>|  ') == "Bad-Name"


def test_render_message_section_uses_stable_role_headings():
    markdown = render_message_section(
        {"role": "assistant", "content": "Line one\nLine two"}
    )

    assert markdown == "## 🤖 Assistant\n\nLine one\nLine two"


def test_render_message_section_preserves_long_markdown_without_callout_prefixes():
    text = (
        "第一段\r\n"
        "\r\n"
        "- 列表1\r\n"
        "- 列表2\r\n"
        "\r\n"
        "> 原始引用\r\n"
        "\r\n"
        "```python\r\n"
        'print("hi")\r\n'
        "```\r\n"
        "\r\n"
        "[链接](https://example.com)"
    )

    markdown = render_message_section({"role": "user", "content": text})

    assert markdown == (
        "## 🧑 User\n\n"
        "第一段\n"
        "\n"
        "- 列表1\n"
        "- 列表2\n"
        "\n"
        "> 原始引用\n"
        "\n"
        "```python\n"
        'print("hi")\n'
        "```\n"
        "\n"
        "[链接](https://example.com)"
    )
    assert "> [!tip]" not in markdown
    assert "> [!note]" not in markdown
    assert "\n> - 列表1" not in markdown
    assert "\n> ```python" not in markdown


def test_export_conversation_splits_parts_and_writes_index(sample_config):
    store = SQLiteStore(sample_config.database_path)
    store.initialize()
    messages = [
        MessageIn(
            id=f"m{i:02d}",
            role="user" if i % 2 else "assistant",
            content=f"Message {i}",
            position=i,
        )
        for i in range(23)
    ]
    store.save_messages("conv-abc", "My / Chat", messages)

    result = export_conversation(sample_config, store, "conv-abc")

    assert result.conversation_dir == Path(sample_config.vault_path) / "AI" / "_ChatGPTSyncTest" / "My - Chat - conv-abc"
    assert [path.name for path in result.part_files] == [
        "part-001.md",
        "part-002.md",
        "part-003.md",
    ]
    assert (result.conversation_dir / "part-001.md").read_text(encoding="utf-8").count("## ") == 10
    assert (result.conversation_dir / "part-003.md").read_text(encoding="utf-8").count("## ") == 3
    index = (result.conversation_dir / "index.md").read_text(encoding="utf-8")
    assert "# My / Chat" in index
    assert "- [[part-001]]" in index
    assert "- [[part-003]]" in index
    assert result.updated_files == ["part-001.md", "part-002.md", "part-003.md", "index.md"]


def test_safe_replace_retries_windows_file_lock(monkeypatch, tmp_path):
    source = tmp_path / "file.md.tmp"
    target = tmp_path / "file.md"
    source.write_text("new", encoding="utf-8")
    target.write_text("old", encoding="utf-8")
    calls = {"count": 0}

    original_replace = Path.replace

    def flaky_replace(self, other):
        calls["count"] += 1
        if calls["count"] < 3:
            error = PermissionError("locked")
            error.winerror = 32
            raise error
        return original_replace(self, other)

    monkeypatch.setattr(Path, "replace", flaky_replace)
    monkeypatch.setattr("chatgpt_obsidian_sync.exporter.time.sleep", lambda _seconds: None)

    warnings = safe_replace(source, target)

    assert calls["count"] == 3
    assert target.read_text(encoding="utf-8") == "new"
    assert warnings == ["file.md replace retried 2 time(s)"]


def test_safe_replace_preserves_old_file_after_winerror_5(monkeypatch, tmp_path):
    source = tmp_path / "file.md.tmp"
    target = tmp_path / "file.md"
    source.write_text("new", encoding="utf-8")
    target.write_text("old", encoding="utf-8")

    def always_locked(self, other):
        error = PermissionError("access denied")
        error.winerror = 5
        raise error

    monkeypatch.setattr(Path, "replace", always_locked)
    monkeypatch.setattr("chatgpt_obsidian_sync.exporter.time.sleep", lambda _seconds: None)

    try:
        safe_replace(source, target)
    except PermissionError:
        pass
    else:
        raise AssertionError("safe_replace should raise after retry exhaustion")

    assert target.read_text(encoding="utf-8") == "old"
