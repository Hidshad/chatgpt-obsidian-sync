import json
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def parse_url_with_node(url: str):
    script = (
        "const { parseConversationIdFromUrl } = require('./browser-extension/conversation-url.js');"
        f"console.log(JSON.stringify(parseConversationIdFromUrl({json.dumps(url)})));"
    )
    result = subprocess.run(
        ["node", "-e", script],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(result.stdout)


def test_parse_conversation_id_from_chatgpt_url():
    assert (
        parse_url_with_node("https://chatgpt.com/c/6a1d98fc-3fec-838f-9b50-474f30391a06")
        == "6a1d98fc-3fec-838f-9b50-474f30391a06"
    )


def test_parse_conversation_id_from_chat_openai_url():
    assert (
        parse_url_with_node("https://chat.openai.com/c/abc123")
        == "abc123"
    )


def test_parse_conversation_id_with_query_hash_and_trailing_slash():
    assert parse_url_with_node("https://chatgpt.com/c/abc123?model=gpt-4o") == "abc123"
    assert parse_url_with_node("https://chatgpt.com/c/abc123#thread") == "abc123"
    assert parse_url_with_node("https://chatgpt.com/c/abc123/") == "abc123"


def test_parse_conversation_id_returns_none_for_non_conversation_pages():
    assert parse_url_with_node("https://chatgpt.com/") is None
    assert parse_url_with_node("https://chatgpt.com/g/g-abc/c/conv-id") is None
    assert parse_url_with_node("https://chatgpt.com/g/g-abc") is None
    assert parse_url_with_node("https://chatgpt.com/settings/") is None
    assert parse_url_with_node("https://chatgpt.com/#pricing") is None
    assert parse_url_with_node("https://chatgpt.com/share/share-id") is None
    assert parse_url_with_node("https://example.com/c/abc123") is None
