from dataclasses import dataclass
from typing import Any

from .schemas import MessageIn


@dataclass(frozen=True)
class ParsedConversation:
    conversation_id: str
    title: str
    messages: list[MessageIn]
    diagnostics: dict[str, Any]


def parse_conversation_json(conversation: dict[str, Any]) -> ParsedConversation:
    conversation_id = str(
        conversation.get("conversation_id")
        or conversation.get("id")
        or ""
    )
    title = str(conversation.get("title") or "Untitled Chat")
    mapping = conversation.get("mapping") or {}

    chain, used_current_node, fallback_used = _main_chain_node_ids(conversation, mapping)
    messages: list[MessageIn] = []
    for current_id in chain:
        node = mapping.get(current_id) or {}
        message = node.get("message")
        parsed = _parse_message(message, len(messages))
        if parsed is not None:
            messages.append(parsed)

    diagnostics = _diagnostics(mapping, chain, messages, used_current_node, fallback_used)

    return ParsedConversation(
        conversation_id=conversation_id,
        title=title,
        messages=messages,
        diagnostics=diagnostics,
    )


def _main_chain_node_ids(
    conversation: dict[str, Any], mapping: dict[str, Any]
) -> tuple[list[str], bool, bool]:
    current_node = str(conversation.get("current_node") or "")
    if current_node and current_node in mapping:
        return _parent_chain(mapping, current_node), True, False

    return _children_chain(mapping), False, True


def _parent_chain(mapping: dict[str, Any], current_node: str) -> list[str]:
    chain: list[str] = []
    visited: set[str] = set()
    node_id = current_node
    while node_id and node_id not in visited and node_id in mapping:
        visited.add(node_id)
        chain.append(node_id)
        parent = mapping.get(node_id, {}).get("parent")
        node_id = str(parent or "")
    chain.reverse()
    return chain


def _children_chain(mapping: dict[str, Any]) -> list[str]:
    chain: list[str] = []
    current_id = _main_chain_start_id(mapping)
    visited: set[str] = set()
    while current_id and current_id not in visited:
        visited.add(current_id)
        chain.append(current_id)
        node = mapping.get(current_id) or {}
        children = node.get("children") or []
        current_id = children[0] if children else ""
    return chain


def _main_chain_start_id(mapping: dict[str, Any]) -> str:
    if "client-created-root" in mapping:
        return "client-created-root"

    for node_id, node in mapping.items():
        if isinstance(node, dict) and node.get("parent") is None:
            return node_id

    return ""


def _diagnostics(
    mapping: dict[str, Any],
    chain: list[str],
    messages: list[MessageIn],
    used_current_node: bool,
    fallback_used: bool,
) -> dict[str, Any]:
    candidate_message_node_count = sum(
        1
        for node in mapping.values()
        if isinstance(node, dict) and _parse_message(node.get("message"), 0) is not None
    )
    branched_node_count = sum(
        1
        for node in mapping.values()
        if isinstance(node, dict) and len(node.get("children") or []) > 1
    )
    warnings: list[str] = []
    if fallback_used:
        warnings.append("current_node missing; used children[0] fallback main chain")
    if branched_node_count > 0:
        warnings.append("conversation contains branched nodes")
    parsed_message_count = len(messages)
    mapping_node_count = len(mapping)
    if mapping_node_count > 50 and parsed_message_count < 10:
        warnings.append("parsed messages very few for large mapping")
    if (
        candidate_message_node_count > 0
        and parsed_message_count > 0
        and candidate_message_node_count > parsed_message_count * 2
    ):
        warnings.append("parsed messages much fewer than candidate message nodes")

    if parsed_message_count == 0:
        quality = "failed"
    elif any(
        warning in warnings
        for warning in [
            "parsed messages very few for large mapping",
            "parsed messages much fewer than candidate message nodes",
        ]
    ):
        quality = "suspect"
    else:
        quality = "ok"

    return {
        "parsed_message_count": parsed_message_count,
        "mapping_node_count": mapping_node_count,
        "candidate_message_node_count": candidate_message_node_count,
        "main_chain_message_count": parsed_message_count,
        "main_chain_node_count": len(chain),
        "branch_count": branched_node_count,
        "branched_node_count": branched_node_count,
        "used_current_node": used_current_node,
        "fallback_used": fallback_used,
        "full_snapshot_quality": quality,
        "warnings": warnings,
    }


def _parse_message(message: dict[str, Any] | None, position: int) -> MessageIn | None:
    if not message:
        return None

    role = ((message.get("author") or {}).get("role") or "").strip().lower()
    if role not in {"user", "assistant"}:
        return None

    content = message.get("content") or {}
    if content.get("content_type") != "text":
        return None

    parts = content.get("parts") or []
    text = "".join(part for part in parts if isinstance(part, str))
    if text == "":
        return None

    message_id = str(message.get("id") or "")
    if not message_id:
        return None

    return MessageIn(
        id=message_id,
        role=role,
        content=text,
        position=position,
    )
