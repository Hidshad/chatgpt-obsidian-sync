import json
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def run_parser_case(payload):
    script = f"""
const {{ parseConversationListResponse, createConversationListDiagnostics }} = require("./browser-extension/conversation-list-parser.js");
const payload = {json.dumps(payload)};
const parsed = parseConversationListResponse(payload);
const diagnostics = createConversationListDiagnostics(JSON.stringify(payload), 200, "/backend-api/conversations", "test");
console.log(JSON.stringify({{ parsed, diagnostics }}));
"""
    result = subprocess.run(
        ["node", "-e", script],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(result.stdout)


def test_parse_conversation_list_response_supports_items():
    result = run_parser_case({"items": [{"id": "c1", "title": "One"}]})

    assert result["parsed"]["conversations"][0]["conversation_id"] == "c1"
    assert "items" in result["parsed"]["diagnostics"]["candidatePaths"]


def test_parse_conversation_list_response_supports_conversations():
    result = run_parser_case({"conversations": [{"conversation_id": "c2", "name": "Two"}]})

    assert result["parsed"]["conversations"][0]["conversation_id"] == "c2"
    assert result["parsed"]["conversations"][0]["title"] == "Two"


def test_parse_conversation_list_response_supports_data_items():
    result = run_parser_case({"data": {"items": [{"conversationId": "c3", "title": "Three"}]}})

    assert result["parsed"]["conversations"][0]["conversation_id"] == "c3"
    assert "data.items" in result["parsed"]["diagnostics"]["candidatePaths"]


def test_parse_conversation_list_response_supports_edges_node():
    result = run_parser_case({"edges": [{"node": {"uuid": "c4", "title": "Four"}}]})

    assert result["parsed"]["conversations"][0]["conversation_id"] == "c4"
    assert "edges[].node" in result["parsed"]["diagnostics"]["candidatePaths"]


def test_parse_conversation_list_response_scans_shallow_candidate_arrays():
    result = run_parser_case({"viewer": {"history": {"rows": [{"id": "c5", "updated_at": 123}]}}})

    assert result["parsed"]["conversations"][0]["conversation_id"] == "c5"
    assert "viewer.history.rows" in result["parsed"]["diagnostics"]["candidatePaths"]


def test_parse_failure_diagnostics_include_structure_summary():
    result = run_parser_case({"unexpected": {"value": 1}})

    diagnostics = result["diagnostics"]
    assert result["parsed"]["conversations"] == []
    assert diagnostics["topLevelKeys"] == ["unexpected"]
    assert diagnostics["responseSize"] > 0
    assert diagnostics["responsePreview"].startswith('{"unexpected"')
