if (
  globalThis.__CHATGPT_OBSIDIAN_SYNC_CONTENT_LOADED &&
  globalThis.__CHATGPT_OBSIDIAN_SYNC_LISTENER_REGISTERED
) {
  // Already loaded in this tab. The existing runtime listener owns ping/start/stop.
} else {
globalThis.__CHATGPT_OBSIDIAN_SYNC_CONTENT_LOADED = true;

const SERVER_BASE = "http://127.0.0.1:8765";
const MESSAGES_URL = `${SERVER_BASE}/api/messages`;
const parseConversationIdFromUrl = ChatGptObsidianUrl.parseConversationIdFromUrl;
const DEFAULT_REALTIME_SYNC_ENABLED = false;
const DEFAULT_REALTIME_SYNC_INTERVAL_SECONDS = 30;
const MIN_REALTIME_SYNC_INTERVAL_SECONDS = 10;
const MAX_REALTIME_SYNC_INTERVAL_SECONDS = 300;
const SUPPORTED_ROLES = new Set(["user", "assistant", "system"]);
const LOCAL_SERVICE_CONNECTION_ERROR = "同步失败：无法连接本地服务 127.0.0.1:8765";
const ACTION_LABELS = new Set([
  "Copy",
  "Edit",
  "Share",
  "Regenerate",
  "Retry",
  "Good response",
  "Bad response",
  "Read aloud",
  "复制",
  "编辑",
  "分享",
  "重新生成",
  "点赞",
  "点踩",
]);
const initialConversationId = parseConversationIdFromUrl(window.location.href);

let realtimeSyncEnabled = DEFAULT_REALTIME_SYNC_ENABLED;
let realtimeSyncIntervalSeconds = DEFAULT_REALTIME_SYNC_INTERVAL_SECONDS;
let syncTimer = null;
let syncInProgress = false;
let lastConversationId = "";
let lastPayloadJson = "";
let pendingPayload = null;
let lastSyncAt = "";
let activeRealtimeSession = null;
const seenMessageIdsByConversation = new Map();

function hashText(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

async function sha256Hex(value) {
  if (globalThis.crypto?.subtle && globalThis.TextEncoder) {
    const encoded = new TextEncoder().encode(value);
    const digest = await crypto.subtle.digest("SHA-256", encoded);
    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }
  return hashText(value).padStart(16, "0");
}

function nowIsoString() {
  return new Date().toISOString();
}

async function writeNonConversationStandbyStatus() {
  try {
    await chrome.storage.local.set({
      realtimeStatus: {
        contentScriptLoaded: true,
        contentScriptLoadedAt: nowIsoString(),
        pageType: "non_conversation",
        enabled: false,
        state: "standby",
        message: "当前不是普通 ChatGPT 会话页，扩展已静默待机",
        lastSyncAt: "",
        lastMessageCount: 0,
        lastConversationId: "",
        lastError: "当前不是普通 ChatGPT 会话页，扩展已静默待机",
        diagnostics: null,
      },
    });
  } catch (_error) {
    // Ignore storage failures on unsupported pages; the important part is staying quiet.
  }
}

function newRealtimeRunId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function normalizeRealtimeIntervalSeconds(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) {
    return DEFAULT_REALTIME_SYNC_INTERVAL_SECONDS;
  }
  return Math.max(
    MIN_REALTIME_SYNC_INTERVAL_SECONDS,
    Math.min(MAX_REALTIME_SYNC_INTERVAL_SECONDS, Math.round(seconds))
  );
}

function getCurrentConversationId() {
  return parseConversationIdFromUrl(window.location.href) || "";
}

function isRealtimeSessionCurrent(conversationId) {
  return Boolean(
    activeRealtimeSession &&
      activeRealtimeSession.enabled &&
      activeRealtimeSession.conversationId === conversationId &&
      conversationId === getCurrentConversationId()
  );
}

function countSelector(selector) {
  return document.querySelectorAll(selector).length;
}

function getMessageScanDiagnostics() {
  const main = document.querySelector("main");
  return {
    currentUrl: window.location.href,
    conversationId: getCurrentConversationId(),
    readyState: document.readyState,
    bodyTextLength: (document.body?.innerText || document.body?.textContent || "").length,
    selectorCounts: {
      role: document.querySelectorAll("[data-message-author-role]").length,
      turnPrefix: countSelector('[data-testid^="conversation-turn"]'),
      turnAny: countSelector('[data-testid*="conversation-turn"]'),
      article: countSelector("article"),
      mainArticle: countSelector("main article"),
      mainRole: countSelector("main [data-message-author-role]"),
      mainConversation: countSelector('main [data-testid*="conversation"]'),
    },
    hasMain: Boolean(main),
    hasTextareaOrContenteditable: Boolean(
      document.querySelector('textarea, [contenteditable="true"], [contenteditable=true]')
    ),
  };
}

function formatSelectorCounts(diagnostics) {
  const counts = diagnostics?.selectorCounts || {};
  return (
    `selector counts: role=${counts.role || 0}, ` +
    `turn=${counts.turnPrefix || counts.turnAny || 0}, ` +
    `article=${counts.article || 0}, ` +
    `mainArticle=${counts.mainArticle || 0}, ` +
    `bodyText=${diagnostics?.bodyTextLength || 0}`
  );
}

function selectorCountsAreEmpty(diagnostics) {
  const counts = diagnostics?.selectorCounts || {};
  return [
    counts.role,
    counts.turnPrefix,
    counts.turnAny,
    counts.article,
    counts.mainArticle,
    counts.mainRole,
    counts.mainConversation,
  ].every((value) => !value);
}

function resetConversationState(conversationId) {
  lastConversationId = conversationId;
  seenMessageIdsByConversation.set(conversationId, new Set());
  pendingPayload = null;
  lastSyncAt = "";
  lastPayloadJson = "";
}

function ensureConversationState(conversationId) {
  if (conversationId !== lastConversationId) {
    resetConversationState(conversationId);
  }
}

function handleRouteChange() {
  const currentConversationId = getCurrentConversationId();
  if (currentConversationId !== lastConversationId) {
    if (realtimeSyncEnabled && activeRealtimeSession) {
      stopRealtimeDueToConversationChange(currentConversationId);
    }
    resetConversationState(currentConversationId);
  }
}

async function stopRealtimeDueToConversationChange(currentConversationId = "") {
  stopRealtimeSyncLocally();
  activeRealtimeSession = null;
  await chrome.storage.local.set({
    realtimeSyncEnabled: false,
    activeRealtimeSession: null,
  });
  await updateRealtimeStatus({
    enabled: false,
    state: "stopped_due_to_conversation_changed",
    message: "实时同步会话与当前页面不一致，已停止同步。",
    lastConversationId: currentConversationId,
    lastMessageCount: 0,
    lastError: "实时同步会话与当前页面不一致，已停止同步。",
  });
}

function isMessageOwnerConflictError(error) {
  return (
    error &&
    (error.serverError === "message_id already belongs to another conversation" ||
      String(error.message || "").includes("message_id already belongs to another conversation"))
  );
}

async function stopRealtimeDueToRejectedPayload(error, conversationId = "") {
  stopRealtimeSyncLocally();
  activeRealtimeSession = null;
  const message = "实时同步已停止：消息归属冲突。请重新完整校准或清理旧数据。";
  await chrome.storage.local.set({
    realtimeSyncEnabled: false,
    activeRealtimeSession: null,
  });
  await updateRealtimeStatus({
    state: "sync_stopped_due_to_rejected_payload",
    message,
    lastSyncAt: nowIsoString(),
    lastConversationId: conversationId || getCurrentConversationId() || "",
    lastMessageCount: 0,
    lastError: message,
    diagnostics: error?.realtimeDiagnostics || null,
  });
}

function titleFromPage() {
  const title = document.title.replace(/\s*[-|]\s*ChatGPT\s*$/i, "").trim();
  return title || "Untitled Chat";
}

function isLikelyChatGptMessageId(value) {
  const text = String(value || "");
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text);
}

function explicitMessageIdFrom(node) {
  const candidates = [
    node,
    node.closest("[data-message-id]"),
    node.querySelector?.("[data-message-id]"),
  ].filter(Boolean);

  for (const candidate of candidates) {
    const dataMessageId = candidate.getAttribute("data-message-id");
    if (isLikelyChatGptMessageId(dataMessageId)) {
      return dataMessageId;
    }
  }

  return "";
}

async function messageIdFor(node, role, position, content, conversationId) {
  const explicitId = explicitMessageIdFrom(node);
  if (explicitId) {
    return explicitId;
  }
  const contentHash = await sha256Hex(content);
  return `realtime:${conversationId}:${role}:${position}:${contentHash.slice(0, 16)}`;
}

function payloadConversationDiagnostics(payload) {
  const messages = Array.isArray(payload?.messages) ? payload.messages : [];
  const messageConversationIds = Array.from(
    new Set(messages.map((message) => String(message.conversation_id || "")))
  );
  return {
    payloadConversationId: String(payload?.conversation_id || ""),
    messageConversationIds,
    messageCount: messages.length,
    firstMessageIds: messages.slice(0, 3).map((message) =>
      String(message.message_id || message.id || "")
    ),
    currentUrl: window.location.href,
    currentConversationId: getCurrentConversationId(),
  };
}

function formatPayloadConversationDiagnostics(diagnostics) {
  return (
    `payloadConversationId=${diagnostics.payloadConversationId || "missing"}；` +
    `messageConversationIds=${diagnostics.messageConversationIds.join(",") || "none"}；` +
    `mismatchCount=${diagnostics.mismatchCount ?? 0}；` +
    `messageCount=${diagnostics.messageCount ?? 0}；` +
    `firstMessageIds=${(diagnostics.firstMessageIds || []).join(",") || "none"}；` +
    `currentConversationId=${diagnostics.currentConversationId || "missing"}`
  );
}

function formatServerErrorDetails(data) {
  const fields = [
    "message_id",
    "existing_conversation_id",
    "payload_conversation_id",
    "message_conversation_ids",
    "mismatch_count",
  ];
  return fields
    .filter((field) => data && data[field] !== undefined && data[field] !== null)
    .map((field) => {
      const value = Array.isArray(data[field]) ? data[field].join(",") : String(data[field]);
      return `${field}=${value}`;
    })
    .join("；");
}

async function postJson(url, payload) {
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (_error) {
    throw new Error(LOCAL_SERVICE_CONNECTION_ERROR);
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) {
    const summary = data.error || data.detail || `Local request failed`;
    const serverDetails = formatServerErrorDetails(data);
    let diagnosticText = serverDetails ? `；${serverDetails}` : "";
    if (String(summary).includes("conversation_id mismatch")) {
      diagnosticText += `；${formatPayloadConversationDiagnostics(
        payloadConversationDiagnostics(payload)
      )}`;
    }
    const error = new Error(
      `同步失败：HTTP ${response.status}: ${String(summary).slice(0, 240)}${diagnosticText}`
    );
    error.httpStatus = response.status;
    error.serverError = String(summary);
    error.serverData = data;
    throw error;
  }
  return data;
}

function validateRealtimePayload(payload, context = {}) {
  const messages = Array.isArray(payload?.messages) ? payload.messages : null;
  const payloadConversationId = String(payload?.conversation_id || "");
  const scannedMessages = Array.isArray(context.scannedMessages)
    ? context.scannedMessages
    : messages || [];
  const runId = String(context.runId || "");
  if (!payloadConversationId) {
    return {
      ok: false,
      reason: "missing conversation_id",
      payloadConversationId,
      messageConversationIds: [],
      mismatchCount: 0,
    };
  }
  if (!messages) {
    return {
      ok: false,
      reason: "messages must be an array",
      payloadConversationId,
      messageConversationIds: [],
      mismatchCount: 0,
    };
  }

  const messageConversationIds = Array.from(
    new Set(messages.map((message) => String(message.conversation_id || "")))
  );
  const mismatches = messages.filter(
    (message) => String(message.conversation_id || "") !== payloadConversationId
  );
  const missingMessageIds = messages.filter(
    (message) => !String(message.message_id || message.id || "")
  );
  const missingRoles = messages.filter((message) => !String(message.role || ""));
  const wrongRunMessages = runId
    ? messages.filter((message) => String(message.observed_run_id || "") !== runId)
    : [];

  if (selectorCountsAreEmpty(context.diagnostics) && messages.length > 0) {
    return {
      ok: false,
      reason: "selector counts empty but payload has messages",
      payloadConversationId,
      messageConversationIds,
      mismatchCount: messages.length,
    };
  }
  if (messages.length !== scannedMessages.length) {
    return {
      ok: false,
      reason: "payload message count differs from current scan",
      payloadConversationId,
      messageConversationIds,
      mismatchCount: Math.abs(messages.length - scannedMessages.length),
    };
  }
  if (mismatches.length > 0) {
    return {
      ok: false,
      reason: "local conversation_id mismatch before POST",
      payloadConversationId,
      messageConversationIds,
      mismatchCount: mismatches.length,
    };
  }
  if (missingMessageIds.length > 0) {
    return {
      ok: false,
      reason: "missing message_id",
      payloadConversationId,
      messageConversationIds,
      mismatchCount: 0,
    };
  }
  if (missingRoles.length > 0) {
    return {
      ok: false,
      reason: "missing role",
      payloadConversationId,
      messageConversationIds,
      mismatchCount: 0,
    };
  }
  if (wrongRunMessages.length > 0) {
    return {
      ok: false,
      reason: "payload contains messages from another realtime run",
      payloadConversationId,
      messageConversationIds,
      mismatchCount: wrongRunMessages.length,
    };
  }
  return {
    ok: true,
    reason: "",
    payloadConversationId,
    messageConversationIds,
    mismatchCount: 0,
  };
}

function assertPayloadConversationConsistency(payload, context = {}) {
  const validation = validateRealtimePayload(payload, context);
  if (!validation.ok) {
    throw new Error(validation.reason);
  }
}

function formatRealtimeValidationError(validation) {
  return (
    `本地拦截：conversation_id mismatch before POST；` +
    `payloadConversationId=${validation.payloadConversationId || "missing"}；` +
    `messageConversationIds=${validation.messageConversationIds.join(",") || "none"}；` +
    `mismatchCount=${validation.mismatchCount}`
  );
}

function isInsidePageChrome(node) {
  return Boolean(
    node.closest(
      'nav, header, footer, aside, [role="navigation"], form, textarea, input, [contenteditable="true"], [contenteditable=true]'
    )
  );
}

function uniqueNodes(nodes) {
  const seen = new Set();
  const unique = [];
  for (const node of nodes) {
    if (!node || seen.has(node) || isInsidePageChrome(node)) {
      continue;
    }
    seen.add(node);
    unique.push(node);
  }
  return unique;
}

function collectCandidates(selector) {
  if (selector.startsWith("main ")) {
    return uniqueNodes(Array.from(document.querySelectorAll(selector)));
  }
  const main = document.querySelector("main");
  const scoped = main ? Array.from(main.querySelectorAll(selector)) : [];
  if (scoped.length > 0) {
    return uniqueNodes(scoped);
  }
  return uniqueNodes(Array.from(document.querySelectorAll(selector)));
}

function explicitRoleFromNode(node) {
  const role =
    node.getAttribute("data-message-author-role") ||
    node.querySelector("[data-message-author-role]")?.getAttribute("data-message-author-role");
  const normalized = String(role || "").toLowerCase();
  return SUPPORTED_ROLES.has(normalized) ? normalized : "";
}

function inferRoleFromNode(node, position) {
  const explicitRole = explicitRoleFromNode(node);
  if (explicitRole) {
    return explicitRole;
  }

  const marker = [
    node.getAttribute("data-testid"),
    node.getAttribute("aria-label"),
    node.className,
    node.textContent?.slice(0, 80),
  ]
    .map((value) => String(value || "").toLowerCase())
    .join(" ");

  if (marker.includes("user")) {
    return "user";
  }
  if (
    marker.includes("assistant") ||
    node.querySelector(".markdown, .prose, [data-testid*='assistant']")
  ) {
    return "assistant";
  }

  // fallback by visible turn order: ChatGPT turns usually alternate starting with the user.
  return position % 2 === 0 ? "user" : "assistant";
}

function collectMessageNodes() {
  const candidateGroups = [
    collectCandidates("[data-message-author-role]"),
    collectCandidates("[data-testid^=\"conversation-turn\"]"),
    collectCandidates("[data-testid*=\"conversation-turn\"]"),
    collectCandidates("main article"),
    collectCandidates("article"),
  ];

  const groupedNodes = candidateGroups.flat();
  const merged = uniqueNodes(groupedNodes).filter((node) => {
    return !groupedNodes.some(
      (other) =>
        other &&
        other !== node &&
        node.contains(other) &&
        explicitRoleFromNode(other)
    );
  });
  merged.sort((left, right) => {
    if (left === right) {
      return 0;
    }
    return left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING
      ? -1
      : 1;
  });
  return merged.map((node, position) => ({
    node,
    role: inferRoleFromNode(node, position),
  }));
}

function normalizeMessageText(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => !ACTION_LABELS.has(line.trim()))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractMessageText(node) {
  const clone = node.cloneNode(true);
  clone.querySelectorAll(
    'button, [role="button"], nav, header, footer, aside, svg, img, textarea, input, [contenteditable="true"], [contenteditable=true], [data-testid*="copy" i], [data-testid*="share" i], [data-testid*="edit" i]'
  )
    .forEach((element) => element.remove());
  const contentNode =
    clone.querySelector(
      ".markdown, .prose, [data-message-author-role], [data-testid*='message']"
    ) || clone;
  return normalizeMessageText(contentNode.innerText || contentNode.textContent || "");
}

async function collectVisibleTextMessages(conversationId, messageNodes, runId) {
  const messages = [];

  for (const [position, messageNode] of messageNodes.entries()) {
    if (conversationId !== getCurrentConversationId()) {
      return [];
    }

    const { node, role } = messageNode;
    if (!SUPPORTED_ROLES.has(role)) {
      continue;
    }

    const content = extractMessageText(node);
    if (!content) {
      continue;
    }

    const messageId = await messageIdFor(node, role, position, content, conversationId);
    messages.push({
      message_id: messageId,
      id: messageId,
      conversation_id: conversationId,
      role,
      text: content,
      content,
      order_index: position,
      position,
      observed_run_id: runId,
    });
  }

  return messages;
}

function buildRealtimePayload({ conversationId, title, messages }) {
  return {
    conversation_id: conversationId,
    title,
    source: "extension-content-realtime",
    is_partial_snapshot: true,
    messages: (Array.isArray(messages) ? messages : []).map((message) => ({
      ...message,
      conversation_id: conversationId,
    })),
  };
}

function textPreview(text) {
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, 120);
}

function buildExtractedMessageDiagnostics(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const last = list[list.length - 1] || null;
  return {
    extracted_message_count: list.length,
    extracted_user_count: list.filter((message) => message.role === "user").length,
    extracted_assistant_count: list.filter((message) => message.role === "assistant").length,
    last_extracted_role: last?.role || "",
    last_extracted_text_preview: textPreview(last?.text || last?.content || ""),
    last_extracted_message_id: last?.message_id || last?.id || "",
    last_extracted_is_fallback: String(last?.message_id || last?.id || "").startsWith(
      `realtime:${last?.conversation_id || ""}:`
    ),
    payload_message_ids_tail: list
      .slice(-5)
      .map((message) => String(message.message_id || message.id || "")),
    payload_text_previews_tail: list
      .slice(-5)
      .map((message) => textPreview(message.text || message.content || "")),
  };
}

async function updateRealtimeStatus(status) {
  const previous = await chrome.storage.local.get(["realtimeStatus"]);
  const previousStatus = previous.realtimeStatus || {};
  const nextStatus = {
    ...previousStatus,
    contentScriptLoaded: true,
    contentScriptLoadedAt: previousStatus.contentScriptLoadedAt || nowIsoString(),
    enabled: realtimeSyncEnabled,
    lastSyncAt: status.lastSyncAt ?? previousStatus.lastSyncAt ?? lastSyncAt,
    lastMessageCount: status.lastMessageCount ?? previousStatus.lastMessageCount ?? 0,
    lastConversationId:
      status.lastConversationId ?? previousStatus.lastConversationId ?? lastConversationId,
    lastError: status.lastError ?? previousStatus.lastError ?? "",
    state: status.state ?? previousStatus.state ?? (realtimeSyncEnabled ? "running" : "idle"),
    message: status.message ?? previousStatus.message ?? "",
    timerRunning: status.timerRunning ?? Boolean(syncTimer),
    activeConversationId:
      status.activeConversationId ??
      activeRealtimeSession?.conversationId ??
      previousStatus.activeConversationId ??
      "",
    diagnostics: status.diagnostics ?? previousStatus.diagnostics ?? null,
    lastWriteResult: status.lastWriteResult ?? previousStatus.lastWriteResult ?? null,
    lastSuccessfulExport:
      status.lastSuccessfulExport ?? previousStatus.lastSuccessfulExport ?? null,
    session: status.session ?? activeRealtimeSession ?? previousStatus.session ?? null,
  };
  await chrome.storage.local.set({
    realtimeStatus: nextStatus,
  });
}

async function writeSkipStatus(lastError, conversationId = "", diagnostics = null) {
  const timestamp = nowIsoString();
  lastSyncAt = timestamp;
  await updateRealtimeStatus({
    lastSyncAt: timestamp,
    lastConversationId: conversationId,
    lastMessageCount: 0,
    lastError,
    diagnostics,
  });
}

async function writeStoppedStatus() {
  await updateRealtimeStatus({
    enabled: false,
    state: "stopped",
    message: "实时同步已停止",
    lastError: "",
    lastConversationId: getCurrentConversationId() || lastConversationId,
  });
}

async function syncCurrentConversationOnce(options = {}) {
  const manual = options.manual === true;
  const runId = newRealtimeRunId();
  const syncConversationId = parseConversationIdFromUrl(window.location.href);
  const diagnostics = getMessageScanDiagnostics();
  if (!syncConversationId) {
    if (manual) {
      throw new Error("当前页面不是普通 ChatGPT 会话页。");
    }
    await writeSkipStatus(
      "跳过：当前页面不是普通 ChatGPT 会话页；跳过：当前页面未识别 conversation_id",
      "",
      diagnostics
    );
    return { status: "skipped" };
  }

  if (!manual && !isRealtimeSessionCurrent(syncConversationId)) {
    await stopRealtimeDueToConversationChange(syncConversationId);
    return { status: "stopped_due_to_conversation_changed" };
  }

  ensureConversationState(syncConversationId);
  if (selectorCountsAreEmpty(diagnostics)) {
    pendingPayload = null;
    if (manual) {
      throw new Error("当前扫描未检测到消息节点。");
    }
    await writeSkipStatus(
      `跳过：当前扫描未检测到消息节点；未发送请求；${formatSelectorCounts(diagnostics)}`,
      syncConversationId,
      diagnostics
    );
    return { status: "empty-scan", messageCount: 0 };
  }

  const messageNodes = collectMessageNodes();
  if (messageNodes.length === 0) {
    pendingPayload = null;
    if (manual) {
      throw new Error("当前页面没有可导出的已加载文字消息。");
    }
    await writeSkipStatus(
      `跳过：当前扫描未检测到消息节点；未发送请求；${formatSelectorCounts(diagnostics)}`,
      syncConversationId,
      diagnostics
    );
    return { status: "empty", messageCount: 0 };
  }

  const messages = await collectVisibleTextMessages(syncConversationId, messageNodes, runId);
  Object.assign(diagnostics, buildExtractedMessageDiagnostics(messages));
  if (messages.length === 0) {
    pendingPayload = null;
    if (manual) {
      throw new Error("当前页面没有可导出的已加载文字消息。");
    }
    await writeSkipStatus(
      `跳过：当前扫描未检测到可同步文字；未发送请求；${formatSelectorCounts(diagnostics)}`,
      syncConversationId,
      diagnostics
    );
    return { status: "empty", messageCount: 0 };
  }

  const payload = buildRealtimePayload({
    conversationId: syncConversationId,
    title: titleFromPage(),
    messages,
  });
  pendingPayload = payload;

  if (payload.conversation_id !== getCurrentConversationId()) {
    pendingPayload = null;
    return { status: "stale" };
  }

  const validation = validateRealtimePayload(payload, {
    scannedMessages: messages,
    runId,
    diagnostics,
  });
  if (!validation.ok) {
    pendingPayload = null;
    const lastError = formatRealtimeValidationError(validation);
    await writeSkipStatus(lastError, syncConversationId, {
      ...diagnostics,
      realtimePayloadValidation: validation,
    });
    if (manual) {
      throw new Error(lastError);
    }
    return { status: "invalid", error: lastError };
  }
  assertPayloadConversationConsistency(payload, {
    scannedMessages: messages,
    runId,
    diagnostics,
  });
  const payloadJson = JSON.stringify(payload);
  if (!manual && payloadJson === lastPayloadJson) {
    pendingPayload = null;
    const timestamp = nowIsoString();
    lastSyncAt = timestamp;
    await updateRealtimeStatus({
      lastSyncAt: timestamp,
      lastConversationId: syncConversationId,
      lastMessageCount: payload.messages.length,
      lastError: "",
      diagnostics,
    });
    return { status: "unchanged", messageCount: payload.messages.length };
  }

  if (syncConversationId !== getCurrentConversationId()) {
    pendingPayload = null;
    return { status: "stale" };
  }

  if (!manual && (!realtimeSyncEnabled || !isRealtimeSessionCurrent(syncConversationId))) {
    pendingPayload = null;
    if (!isRealtimeSessionCurrent(syncConversationId)) {
      await stopRealtimeDueToConversationChange(syncConversationId);
      return { status: "stopped_due_to_conversation_changed" };
    }
    return { status: "stopped" };
  }

  let result;
  try {
    result = await postJson(MESSAGES_URL, payload);
  } catch (error) {
    error.realtimeDiagnostics = diagnostics;
    error.realtimePayloadDiagnostics = payloadConversationDiagnostics(payload);
    if (isMessageOwnerConflictError(error)) {
      await stopRealtimeDueToRejectedPayload(error, syncConversationId);
      return { status: "sync_stopped_due_to_rejected_payload" };
    }
    throw error;
  }

  if (syncConversationId !== getCurrentConversationId()) {
    pendingPayload = null;
    return { status: "stale" };
  }

  lastPayloadJson = payloadJson;
  pendingPayload = null;
  const seenMessageIds = seenMessageIdsByConversation.get(syncConversationId) || new Set();
  seenMessageIdsByConversation.set(syncConversationId, seenMessageIds);
  for (const message of payload.messages) {
    seenMessageIds.add(message.message_id);
  }
  lastSyncAt = nowIsoString();
  await updateRealtimeStatus({
    lastSyncAt,
    lastMessageCount: payload.messages.length,
    lastConversationId: syncConversationId,
    lastError: "",
    diagnostics,
    lastWriteResult: {
      receivedMessages: result.received_messages ?? payload.messages.length,
      insertedMessages: result.inserted_messages ?? result.saved ?? 0,
      updatedMessages: result.updated_messages ?? 0,
      skippedMessages: result.skipped_messages ?? result.skipped ?? 0,
      messageCountAfter: result.message_count_after ?? 0,
      insertedTail: Array.isArray(result.inserted_tail) ? result.inserted_tail : [],
      exportAttempted: Boolean(result.export_attempted),
      exported: Boolean(result.exported),
      outputFolder: result.output_folder || result.conversation_dir || "",
      updatedFiles: Array.isArray(result.updated_files) ? result.updated_files : [],
      exportError: result.export_error || "",
      warnings: Array.isArray(result.warnings) ? result.warnings : [],
      maxOrderIndexBefore: result.max_order_index_before ?? null,
      maxOrderIndexAfter: result.max_order_index_after ?? null,
      insertedOrderIndexes: Array.isArray(result.inserted_order_indexes)
        ? result.inserted_order_indexes
        : [],
      updatedOrderIndexes: Array.isArray(result.updated_order_indexes)
        ? result.updated_order_indexes
        : [],
      skippedMessageIdsTail: Array.isArray(result.skipped_message_ids_tail)
        ? result.skipped_message_ids_tail
        : [],
      insertedMessageIds: Array.isArray(result.inserted_message_ids)
        ? result.inserted_message_ids
        : [],
      },
    lastSuccessfulExport:
      result.exported === true
        ? {
            at: result.last_successful_export_at || nowIsoString(),
            outputFolder:
              result.last_successful_export_output_folder ||
              result.output_folder ||
              result.conversation_dir ||
              "",
            updatedFiles: Array.isArray(result.last_successful_export_updated_files)
              ? result.last_successful_export_updated_files
              : Array.isArray(result.updated_files)
                ? result.updated_files
                : [],
            sectionCount: result.last_successful_export_section_count ?? 0,
            partCount: result.last_successful_export_part_count ?? 0,
            lastTextPreview: result.last_successful_export_last_text_preview || "",
            lastRole: result.last_successful_export_last_role || "",
            lastOrderIndex: result.last_successful_export_last_order_index ?? null,
            lastPartFilename: result.last_successful_export_last_part_filename || "",
          }
        : undefined,
  });
  console.info(
    `[ChatGPT Obsidian Sync] realtime text sync: ${payload.messages.length} messages`
  );

  return {
    status: "ok",
    conversation_id: payload.conversation_id,
    title: payload.title,
    exported_messages: payload.messages.length,
    saved: result.saved || 0,
    skipped: result.skipped || 0,
  };
}

async function runRealtimeSyncOnce() {
  if (!realtimeSyncEnabled || syncInProgress) {
    return;
  }

  syncInProgress = true;
  try {
    await syncCurrentConversationOnce();
  } catch (error) {
    const message = String(error && error.message ? error.message : error);
    const lastError = message.startsWith("同步失败：") ? message : `同步失败：${message}`;
    const timestamp = nowIsoString();
    lastSyncAt = timestamp;
    await updateRealtimeStatus({
      lastSyncAt: timestamp,
      lastConversationId: getCurrentConversationId() || lastConversationId,
      lastMessageCount: 0,
      lastError,
      diagnostics: error.realtimeDiagnostics || getMessageScanDiagnostics(),
    });
  } finally {
    syncInProgress = false;
  }
}

async function exportVisibleConversationOnce() {
  if (syncInProgress) {
    throw new Error("页面采集正在运行，请稍后再试。");
  }

  syncInProgress = true;
  try {
    return await syncCurrentConversationOnce({ manual: true });
  } finally {
    syncInProgress = false;
  }
}

function clearRealtimeTimer() {
  if (syncTimer) {
    clearTimeout(syncTimer);
    syncTimer = null;
  }
}

function isRealtimeTimerRunning() {
  return Boolean(syncTimer);
}

function stopRealtimeSyncLocally() {
  realtimeSyncEnabled = false;
  clearRealtimeTimer();
  pendingPayload = null;
  lastPayloadJson = "";
}

function startRealtimeTimer(runImmediately) {
  clearRealtimeTimer();
  if (!realtimeSyncEnabled) {
    return;
  }
  if (runImmediately) {
    runRealtimeSyncOnce();
  }
  syncTimer = setTimeout(async () => {
    await runRealtimeSyncOnce();
    startRealtimeTimer(false);
  }, realtimeSyncIntervalSeconds * 1000);
}

function restartRealtimeTimer() {
  startRealtimeTimer(false);
}

async function loadRealtimeSettings() {
  const values = await chrome.storage.local.get([
    "realtimeSyncEnabled",
    "realtimeSyncIntervalSeconds",
    "realtimeStatus",
    "activeRealtimeSession",
  ]);
  activeRealtimeSession = values.activeRealtimeSession || null;
  realtimeSyncEnabled =
    typeof values.realtimeSyncEnabled === "boolean"
      ? values.realtimeSyncEnabled
      : DEFAULT_REALTIME_SYNC_ENABLED;
  if (!isRealtimeSessionCurrent(getCurrentConversationId())) {
    realtimeSyncEnabled = false;
  }
  realtimeSyncIntervalSeconds = normalizeRealtimeIntervalSeconds(
    values.realtimeSyncIntervalSeconds
  );

  if (typeof values.realtimeSyncEnabled !== "boolean") {
    await chrome.storage.local.set({
      realtimeSyncEnabled: DEFAULT_REALTIME_SYNC_ENABLED,
    });
  }
  if (values.realtimeSyncIntervalSeconds !== realtimeSyncIntervalSeconds) {
    await chrome.storage.local.set({
      realtimeSyncIntervalSeconds,
    });
  }
  await updateRealtimeStatus({
    lastSyncAt: values.realtimeStatus?.lastSyncAt || "",
    lastMessageCount: values.realtimeStatus?.lastMessageCount || 0,
    lastConversationId: values.realtimeStatus?.lastConversationId || "",
    activeConversationId: activeRealtimeSession?.conversationId || "",
    timerRunning: isRealtimeTimerRunning(),
    lastError: values.realtimeStatus?.lastError || "",
  });
  if (realtimeSyncEnabled && isRealtimeSessionCurrent(getCurrentConversationId())) {
    startRealtimeTimer(true);
  }
}

function registerContentMessageListener() {
  if (globalThis.__CHATGPT_OBSIDIAN_SYNC_LISTENER_REGISTERED) {
    return;
  }
  globalThis.__CHATGPT_OBSIDIAN_SYNC_LISTENER_REGISTERED = true;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message) {
      return false;
    }

    if (
      message.type === "CHATGPT_OBSIDIAN_PING" ||
      message.type === "PING_REALTIME_CONTENT_SCRIPT"
    ) {
      sendResponse({
        ok: true,
        contentScriptLoaded: true,
        conversationId: getCurrentConversationId(),
        activeConversationId: activeRealtimeSession?.conversationId || "",
        timerRunning: isRealtimeTimerRunning(),
        realtimeEnabled: realtimeSyncEnabled,
      });
      return false;
    }

    if (
      message.type === "REALTIME_SYNC_TOGGLE" ||
      message.type === "START_REALTIME_SYNC" ||
      message.type === "STOP_REALTIME_SYNC"
    ) {
      (async () => {
        const shouldEnable =
          message.type === "START_REALTIME_SYNC"
            ? true
            : message.type === "STOP_REALTIME_SYNC"
              ? false
              : Boolean(message.enabled);
        activeRealtimeSession = message.session || null;
        realtimeSyncEnabled = shouldEnable;
        if (realtimeSyncEnabled) {
          if (!isRealtimeSessionCurrent(getCurrentConversationId())) {
            await stopRealtimeDueToConversationChange(getCurrentConversationId());
            sendResponse({
              ok: false,
              error: "realtime session does not match current conversation",
            });
            return;
          }
          await updateRealtimeStatus({
            lastSyncAt,
            lastConversationId: activeRealtimeSession.conversationId,
            activeConversationId: activeRealtimeSession.conversationId,
            lastError: "",
            state: "running",
            message: "实时同步已开启",
            session: activeRealtimeSession,
          });
          startRealtimeTimer(true);
          await updateRealtimeStatus({ timerRunning: isRealtimeTimerRunning() });
        } else {
          activeRealtimeSession = null;
          stopRealtimeSyncLocally();
          await writeStoppedStatus();
        }
        sendResponse({
          ok: true,
          timerRunning: isRealtimeTimerRunning(),
          conversationId: getCurrentConversationId(),
          activeConversationId: activeRealtimeSession?.conversationId || "",
        });
      })().catch((error) =>
        sendResponse({
          ok: false,
          error: String(error && error.message ? error.message : error),
        })
      );
      return true;
    }

    if (message.type !== "exportVisibleConversation") {
      return false;
    }
    exportVisibleConversationOnce()
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) =>
        sendResponse({
          ok: false,
          error: String(error && error.message ? error.message : error),
        })
      );
    return true;
  });
}

function initializeConversationContentScript() {
  console.info("[ChatGPT Obsidian Sync] content script loaded");

  registerContentMessageListener();

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") {
      return;
    }
    if (changes.activeRealtimeSession) {
      activeRealtimeSession = changes.activeRealtimeSession.newValue || null;
      realtimeSyncEnabled = Boolean(activeRealtimeSession && activeRealtimeSession.enabled);
      if (realtimeSyncEnabled && isRealtimeSessionCurrent(getCurrentConversationId())) {
        updateRealtimeStatus({
          lastSyncAt,
          lastConversationId: activeRealtimeSession.conversationId,
          activeConversationId: activeRealtimeSession.conversationId,
          lastError: "",
          state: "running",
          message: "实时同步已开启",
        });
        startRealtimeTimer(true);
        updateRealtimeStatus({ timerRunning: isRealtimeTimerRunning() });
      } else {
        stopRealtimeSyncLocally();
        writeStoppedStatus();
      }
    }
    if (changes.realtimeSyncEnabled && !changes.activeRealtimeSession) {
      realtimeSyncEnabled = Boolean(changes.realtimeSyncEnabled.newValue);
      if (realtimeSyncEnabled) {
        if (!isRealtimeSessionCurrent(getCurrentConversationId())) {
          stopRealtimeDueToConversationChange(getCurrentConversationId());
          return;
        }
        updateRealtimeStatus({
          lastSyncAt,
          lastConversationId,
          activeConversationId: lastConversationId,
          lastError: "",
          state: "running",
          message: "实时同步已开启",
        });
        startRealtimeTimer(true);
        updateRealtimeStatus({ timerRunning: isRealtimeTimerRunning() });
      } else {
        stopRealtimeSyncLocally();
        writeStoppedStatus();
      }
    }
    if (changes.realtimeSyncIntervalSeconds) {
      realtimeSyncIntervalSeconds = normalizeRealtimeIntervalSeconds(
        changes.realtimeSyncIntervalSeconds.newValue
      );
      if (changes.realtimeSyncIntervalSeconds.newValue !== realtimeSyncIntervalSeconds) {
        chrome.storage.local.set({ realtimeSyncIntervalSeconds });
      }
      restartRealtimeTimer();
    }
  });

  const observer = new MutationObserver(() => {
    handleRouteChange();
    if (realtimeSyncEnabled) {
      restartRealtimeTimer();
    }
  });

  if (document.body) {
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }

  loadRealtimeSettings();
}

if (!initialConversationId) {
  registerContentMessageListener();
  writeNonConversationStandbyStatus();
  console.info("[ChatGPT Obsidian Sync] content script standby: non-conversation page");
} else {
  initializeConversationContentScript();
}
}
