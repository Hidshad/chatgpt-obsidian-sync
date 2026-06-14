(function exposeConversationListParser(root) {
  const FIXED_ARRAY_PATHS = [
    ["items"],
    ["conversations"],
    ["data"],
    ["results"],
    ["list"],
    ["nodes"],
    ["edges"],
    ["data", "items"],
    ["data", "conversations"],
    ["data", "results"],
    ["response", "items"],
    ["response", "conversations"]
  ];

  function isObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function pathLabel(path) {
    const label = path.join(".");
    return label === "edges" ? "edges[].node" : label;
  }

  function getPathValue(value, path) {
    return path.reduce((current, key) => (current && current[key] !== undefined ? current[key] : undefined), value);
  }

  function unwrapItem(item) {
    if (isObject(item) && isObject(item.node)) {
      return item.node;
    }
    return item;
  }

  function getConversationId(item) {
    const source = unwrapItem(item);
    if (!isObject(source)) return "";
    return String(source.id || source.conversation_id || source.conversationId || source.uuid || "");
  }

  function hasConversationLikeShape(item) {
    const source = unwrapItem(item);
    if (!isObject(source)) return false;
    const hasId = Boolean(source.id || source.conversation_id || source.conversationId || source.uuid);
    const hasMetadata = Boolean(
      source.title ||
      source.name ||
      source.create_time ||
      source.created_at ||
      source.update_time ||
      source.updated_at
    );
    return hasId && hasMetadata;
  }

  function normalizeConversation(item) {
    const source = unwrapItem(item);
    if (!isObject(source)) return null;
    const conversationId = getConversationId(source);
    if (!conversationId) return null;
    return {
      conversation_id: conversationId,
      title: String(source.title || source.name || "Untitled Chat"),
      create_time: source.create_time || source.created_at || source.createTime || "",
      update_time: source.update_time || source.updated_at || source.updateTime || source.created_at || source.create_time || ""
    };
  }

  function firstItemKeysFromArray(items) {
    const first = items.find((item) => isObject(unwrapItem(item)));
    const source = unwrapItem(first);
    return source ? Object.keys(source) : [];
  }

  function pushCandidate(diagnostics, path, items) {
    const label = Array.isArray(path) ? pathLabel(path) : String(path);
    diagnostics.candidatePaths.push(label);
    diagnostics.candidateLengths[label] = Array.isArray(items) ? items.length : 0;
    if (diagnostics.firstItemKeys.length === 0 && Array.isArray(items)) {
      diagnostics.firstItemKeys = firstItemKeysFromArray(items);
    }
  }

  function normalizeItems(items) {
    return items.map(normalizeConversation).filter(Boolean);
  }

  function scanArrayCandidates(value, maxDepth) {
    const found = [];
    const seen = new Set();

    function visit(current, path, depth) {
      if (depth > maxDepth || !isObject(current)) return;
      for (const [key, child] of Object.entries(current)) {
        const nextPath = path.concat(key);
        if (Array.isArray(child)) {
          const label = pathLabel(nextPath);
          if (!seen.has(label)) {
            seen.add(label);
            const objectItems = child.filter((item) => isObject(unwrapItem(item)));
            if (objectItems.length > 0) {
              found.push({
                path: nextPath,
                items: child,
                usable: objectItems.some(hasConversationLikeShape)
              });
            }
          }
        } else if (isObject(child)) {
          visit(child, nextPath, depth + 1);
        }
      }
    }

    visit(value, [], 0);
    return found;
  }

  function parseConversationListResponse(json) {
    const diagnostics = {
      topLevelKeys: isObject(json) ? Object.keys(json) : [],
      candidatePaths: [],
      candidateLengths: {},
      firstItemKeys: []
    };

    for (const path of FIXED_ARRAY_PATHS) {
      const value = getPathValue(json, path);
      if (!Array.isArray(value)) continue;
      pushCandidate(diagnostics, path, value);
      const conversations = normalizeItems(value);
      if (conversations.length > 0) {
        return { conversations, diagnostics };
      }
    }

    for (const candidate of scanArrayCandidates(json, 3)) {
      pushCandidate(diagnostics, candidate.path, candidate.items);
      if (!candidate.usable) continue;
      const conversations = normalizeItems(candidate.items);
      if (conversations.length > 0) {
        return { conversations, diagnostics };
      }
    }

    return { conversations: [], diagnostics };
  }

  function createConversationListDiagnostics(responseText, status, url, fetchMethod) {
    const diagnostics = {
      listFetchUrl: url || "",
      httpStatus: status || 0,
      responseSize: String(responseText || "").length,
      topLevelKeys: [],
      candidatePaths: [],
      candidateLengths: {},
      firstItemKeys: [],
      responsePreview: String(responseText || "").slice(0, 300),
      fetchMethod: fetchMethod || "unknown"
    };

    try {
      const json = JSON.parse(responseText || "{}");
      const parsed = parseConversationListResponse(json);
      return {
        ...diagnostics,
        ...parsed.diagnostics
      };
    } catch (_error) {
      return {
        ...diagnostics,
        topLevelKeys: ["<invalid-json>"]
      };
    }
  }

  root.parseConversationListResponse = parseConversationListResponse;
  root.createConversationListDiagnostics = createConversationListDiagnostics;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      parseConversationListResponse,
      createConversationListDiagnostics
    };
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
