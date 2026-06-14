importScripts("conversation-url.js", "conversation-list-parser.js");

const SERVER_BASE = "http://127.0.0.1:8765";
const DEBUGGER_VERSION = "1.3";
const DEFAULT_SAFE_MODE = true;
const IMPORT_COOLDOWN_MS = 20000;
const DEFAULT_ADVANCED_COOLDOWN_SECONDS = 20;
const DEFAULT_BULK_INTERVAL_SECONDS = 20;
const DEFAULT_BULK_MAX_COUNT = 20;
const CAPTURE_TIMEOUT_MS = 30000;
const CONTENT_SCRIPT_REFRESH_ADVICE =
  "如果重新加载扩展后检测不到页面脚本，请刷新当前 ChatGPT 会话页后重试。";

let bulkState = createIdleBulkState();
let bulkSessionTarget = null;
let bulkBackgroundTabId = null;
let taskState = createIdleTaskState();
let scannedConversations = [];
let scannedBaseOrigin = "";

function createActiveRealtimeSession(tab, conversationId) {
  return {
    tabId: tab.id,
    conversationId,
    enabled: true,
    startedAt: new Date().toISOString()
  };
}

function getConversationId(pageUrl) {
  return ChatGptObsidianUrl.parseConversationIdFromUrl(pageUrl);
}

function isSupportedChatPage(pageUrl) {
  return Boolean(getConversationId(pageUrl));
}

function isChatGPTPage(pageUrl) {
  try {
    const url = new URL(pageUrl);
    return ["chatgpt.com", "chat.openai.com"].includes(url.hostname);
  } catch (_error) {
    return false;
  }
}

function createIdleBulkState() {
  return {
    mode: "idle",
    running: false,
    stopRequested: false,
    total: 0,
    index: 0,
    currentTitle: "",
    currentConversationId: "",
    success: 0,
    failed: 0,
    skipped: 0,
    waitingSeconds: 0,
    recentError: "",
    bulkIntervalSeconds: DEFAULT_BULK_INTERVAL_SECONDS,
    bulkMaxCount: DEFAULT_BULK_MAX_COUNT,
    bulkUseAll: false
  };
}

function createIdleTaskState() {
  return {
    type: "idle",
    status: "idle",
    current: 0,
    total: 0,
    title: "",
    success: 0,
    failed: 0,
    skipped: 0,
    waitingSeconds: 0,
    lastError: "",
    suggestion: "",
    diagnostics: null,
    startedAt: 0,
    updatedAt: 0
  };
}

function updateTaskState(patch) {
  taskState = {
    ...taskState,
    ...patch,
    updatedAt: Date.now()
  };
  return { ...taskState };
}

function startTask(type, patch) {
  taskState = {
    ...createIdleTaskState(),
    type,
    status: "running",
    startedAt: Date.now(),
    updatedAt: Date.now(),
    ...(patch || {})
  };
  return { ...taskState };
}

async function getTaskState() {
  return { ...taskState };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.round(number)));
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
}

async function checkService() {
  try {
    const res = await fetch(`${SERVER_BASE}/health`, { cache: "no-store" });
    return { connected: res.ok };
  } catch (error) {
    return { connected: false, error: String(error && error.message ? error.message : error) };
  }
}

async function storageGet(keys) {
  return chrome.storage.local.get(keys);
}

async function storageSet(values) {
  return chrome.storage.local.set(values);
}

async function getActiveRealtimeSession() {
  const state = await storageGet(["activeRealtimeSession"]);
  const session = state.activeRealtimeSession;
  return session && session.enabled ? session : null;
}

async function notifyRealtimeSessionTab(session, enabled) {
  if (!session || !session.tabId) {
    return { ok: false, error: "missing realtime session tabId" };
  }
  try {
    return await chrome.tabs.sendMessage(session.tabId, {
      type: enabled ? "START_REALTIME_SYNC" : "STOP_REALTIME_SYNC",
      enabled: Boolean(enabled),
      session: enabled ? session : null
    });
  } catch (error) {
    return {
      ok: false,
      error: String(error && error.message ? error.message : error)
    };
  }
}

function isMissingContentScriptReceiver(error) {
  const message = String(error && error.message ? error.message : error || "");
  return (
    message.includes("Could not establish connection") ||
    message.includes("Receiving end does not exist")
  );
}

async function pingContentScript(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      type: "CHATGPT_OBSIDIAN_PING"
    });
    if (response && response.ok === true && response.contentScriptLoaded === true) {
      return response;
    }
    return {
      ok: false,
      error: response && response.error ? response.error : "content script ping returned no loaded state"
    };
  } catch (error) {
    return {
      ok: false,
      missingReceiver: isMissingContentScriptReceiver(error),
      error: String(error && error.message ? error.message : error)
    };
  }
}

async function executeContentScriptFile(tabId, file) {
  const result = await chrome.scripting.executeScript({
    target: { tabId },
    files: [file]
  });
  if (chrome.runtime.lastError) {
    throw new Error(chrome.runtime.lastError.message);
  }
  return result;
}

async function injectContentScript(tabId) {
  const urlResult = await executeContentScriptFile(tabId, "conversation-url.js");
  const contentResult = await executeContentScriptFile(tabId, "content.js");
  return {
    urlResult,
    contentResult
  };
}

async function ensureContentScript(tab) {
  if (!tab || !tab.id) {
    throw new Error(`content script 注入失败，请刷新 ChatGPT 页面后重试。${CONTENT_SCRIPT_REFRESH_ADVICE} stage=inject-failed`);
  }
  if (!isSupportedChatPage(tab.url || "")) {
    throw new Error("当前页面不是普通 ChatGPT 会话页，请打开 https://chatgpt.com/c/<conversation_id>。");
  }

  const firstPing = await pingContentScript(tab.id);
  if (firstPing.ok) {
    return {
      ...firstPing,
      stage: "ping-ok",
      tabId: tab.id,
      url: tab.url || "",
      injected: false
    };
  }

  const injecting = {
    ok: false,
    stage: "injecting",
    tabId: tab.id,
    url: tab.url || "",
    error: firstPing.error || ""
  };
  let injectionResult = null;
  try {
    injectionResult = await injectContentScript(tab.id);
    await delay(100);
  } catch (error) {
    const failed = {
      ok: false,
      stage: "inject-failed",
      tabId: tab.id,
      url: tab.url || "",
      error: String(error && error.message ? error.message : error)
    };
    throw new Error(
      `content script 注入失败，请刷新 ChatGPT 页面后重试。${CONTENT_SCRIPT_REFRESH_ADVICE} stage=${failed.stage}; tabId=${failed.tabId}; error=${failed.error}`
    );
  }

  const secondPing = await pingContentScript(tab.id);
  if (secondPing.ok) {
    return {
      ...secondPing,
      stage: "inject-ok",
      tabId: tab.id,
      url: tab.url || "",
      executeScriptResult: injectionResult,
      injected: true
    };
  }

  const failed = {
    ok: false,
    stage: "ping-after-inject-failed",
    tabId: tab.id,
    url: tab.url || "",
    error: `注入执行成功，但 content script 未响应。${secondPing.error || ""}`
  };
  throw new Error(
    `content script 注入失败，请刷新 ChatGPT 页面后重试。${CONTENT_SCRIPT_REFRESH_ADVICE} stage=${failed.stage}; tabId=${failed.tabId}; error=${failed.error}`
  );
}

async function clearActiveRealtimeSession(reason) {
  const session = await getActiveRealtimeSession();
  await storageSet({
    realtimeSyncEnabled: false,
    activeRealtimeSession: null,
    realtimeStatus: {
      enabled: false,
      state: reason || "stopped",
      message:
        reason === "stopped_due_to_conversation_changed"
          ? "实时同步会话与当前页面不一致，已停止同步。"
          : "实时同步已停止",
      lastError: "",
      lastConversationId: "",
      updatedAt: new Date().toISOString()
    }
  });
  if (session) {
    await notifyRealtimeSessionTab(session, false);
  }
  return session;
}

async function stopRealtimeSessionBecause(reason) {
  return clearActiveRealtimeSession(reason);
}

async function getSafeMode() {
  const state = await storageGet(["safeMode"]);
  return typeof state.safeMode === "boolean" ? state.safeMode : DEFAULT_SAFE_MODE;
}

async function getAdvancedCooldownSeconds() {
  const state = await storageGet(["advancedCooldownSeconds"]);
  const seconds = Number(state.advancedCooldownSeconds);
  if (!Number.isFinite(seconds)) {
    return DEFAULT_ADVANCED_COOLDOWN_SECONDS;
  }
  return Math.max(0, Math.min(60, seconds));
}

async function setSafeMode(value) {
  const safeMode = Boolean(value);
  await storageSet({ safeMode });
  return safeMode;
}

async function setAdvancedCooldownSeconds(value) {
  const seconds = Number(value);
  const advancedCooldownSeconds = Number.isFinite(seconds)
    ? Math.max(0, Math.min(60, seconds))
    : DEFAULT_ADVANCED_COOLDOWN_SECONDS;
  await storageSet({ advancedCooldownSeconds });
  return advancedCooldownSeconds;
}

function normalizeBulkOptions(options) {
  const bulkIntervalSeconds = clampNumber(
    options && options.bulkIntervalSeconds,
    0,
    3600,
    DEFAULT_BULK_INTERVAL_SECONDS
  );
  const bulkUseAll = Boolean(options && options.bulkUseAll);
  const bulkMaxCount = clampNumber(
    options && options.bulkMaxCount,
    1,
    100000,
    DEFAULT_BULK_MAX_COUNT
  );
  return { bulkIntervalSeconds, bulkMaxCount, bulkUseAll };
}

async function getBulkStatus() {
  return { ...bulkState };
}

async function stopBulkImport() {
  if (!bulkState.running) {
    return getBulkStatus();
  }

  bulkState.stopRequested = true;
  bulkState.mode = "stopping";
  bulkState.recentError = "用户请求停止批量导出。";

  if (bulkSessionTarget) {
    try {
      await chrome.debugger.detach(bulkSessionTarget);
    } catch (_error) {
      // The debugger may already be detached by timeout, navigation, or completion.
    }
  }
  await closeBackgroundTab(bulkBackgroundTabId);
  updateTaskState({
    type: "bulk-import",
    status: "stopped",
    lastError: "用户请求停止批量导出。",
    suggestion: "已停止后续导出，已经导出的内容会保留。"
  });

  return getBulkStatus();
}

async function enforceImportCooldown(now, safeMode, advancedCooldownSeconds) {
  const cooldownMs = safeMode ? IMPORT_COOLDOWN_MS : advancedCooldownSeconds * 1000;

  const state = await storageGet(["lastImportAt"]);
  const lastImportAt = Number(state.lastImportAt || 0);
  const elapsed = now - lastImportAt;

  if (elapsed >= 0 && elapsed < cooldownMs) {
    const remainingSeconds = Math.ceil((cooldownMs - elapsed) / 1000);
    throw new Error(`为避免过于频繁访问，请等待 ${remainingSeconds} 秒后再试。`);
  }

  await storageSet({ lastImportAt: now, safeMode });
}

function summarizeConversationResponse(responseText) {
  const summary = {
    conversation_id: "",
    title: "",
    message_count: 0,
    response_size: responseText.length,
    import_status: "captured"
  };

  try {
    const data = JSON.parse(responseText);
    summary.conversation_id = String(data.conversation_id || data.id || "");
    summary.title = String(data.title || "");
    const mapping = data.mapping || {};
    summary.message_count = Object.values(mapping).filter((node) => {
      const message = node && node.message;
      const role = message && message.author && message.author.role;
      const contentType = message && message.content && message.content.content_type;
      return ["user", "assistant"].includes(role) && contentType === "text";
    }).length;
  } catch (_error) {
    summary.import_status = "captured_non_json";
  }

  return summary;
}

async function postConversationJson(responseText) {
  let requestBody = responseText;
  try {
    const data = JSON.parse(responseText);
    data.source = "conversation-json-full";
    data.is_partial_snapshot = false;
    requestBody = JSON.stringify(data);
  } catch (_error) {
    requestBody = responseText;
  }
  const res = await fetch(`${SERVER_BASE}/api/conversation/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: requestBody
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || `Local import failed: ${res.status}`);
  }
  console.info("[ChatGPT Obsidian Sync] import status", {
    conversation_id: data.conversation_id || "",
    title: data.title || "",
    message_count:
      (data.imported_messages || 0) + (data.updated_messages || 0) + (data.skipped_messages || 0),
    response_size: requestBody.length,
    import_status: "imported"
  });
  return data;
}

async function getConversationStatus(conversationId) {
  const res = await fetch(
    `${SERVER_BASE}/api/conversation/status?conversation_id=${encodeURIComponent(conversationId)}`,
    { cache: "no-store" }
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || `Conversation status failed: ${res.status}`);
  }
  return data;
}

async function regenerateConversationNotes(conversationId) {
  const res = await fetch(`${SERVER_BASE}/api/conversation/export`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conversation_id: conversationId })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || data.export_error || `Markdown export failed: ${res.status}`);
  }
  return data;
}

function debuggerCommand(target, method, params) {
  return chrome.debugger.sendCommand(target, method, params || {});
}

async function createDebuggerSession(tabId) {
  const target = { tabId };
  await chrome.debugger.attach(target, DEBUGGER_VERSION);
  await debuggerCommand(target, "Network.enable");
  return target;
}

async function detachDebuggerSession(target) {
  if (!target) return;
  try {
    await chrome.debugger.detach(target);
  } catch (_error) {
    // The browser may already detach when the tab closes, navigates, or a stop request fires.
  }
}

async function createBackgroundTab(url) {
  return chrome.tabs.create({
    url: url || "about:blank",
    active: false
  });
}

async function closeBackgroundTab(tabId) {
  if (!tabId) return;
  try {
    await chrome.tabs.remove(tabId);
  } catch (_error) {
    // The tab may already be closed by the user or browser.
  }
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      clearTimeout(timeoutId);
      resolve();
    };
    const onUpdated = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        finish();
      }
    };
    const timeoutId = setTimeout(finish, timeoutMs || 10000);
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

async function captureNetworkResponse(target, tabId, matcher, trigger, timeoutMessage) {
  let matchedRequestId = null;
  let matchedStatus = 0;
  let matchedUrl = "";
  let settled = false;

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      chrome.debugger.onEvent.removeListener(onDebuggerEvent);
      chrome.debugger.onDetach.removeListener(onDebuggerDetach);
      clearTimeout(timeoutId);
    };

    const finish = (callback) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };

    const onDebuggerDetach = (source, reason) => {
      if (source.tabId !== tabId || settled) return;
      finish(() => reject(new Error(`Debugger detached before capture completed: ${reason}`)));
    };

    const onDebuggerEvent = async (source, method, params) => {
      if (source.tabId !== tabId || settled) return;

      if (method === "Network.responseReceived") {
        const responseUrl = params.response && params.response.url;
        if (!responseUrl || !matcher(responseUrl, params)) return;
        matchedRequestId = params.requestId;
        matchedStatus = params.response.status || 0;
        matchedUrl = responseUrl;
      }

      if (method === "Network.loadingFinished" && params.requestId === matchedRequestId) {
        try {
          const body = await debuggerCommand(target, "Network.getResponseBody", {
            requestId: params.requestId
          });
          const responseText = body.base64Encoded ? atob(body.body) : body.body;
          finish(() =>
            resolve({
              ok: matchedStatus >= 200 && matchedStatus < 300,
              status: matchedStatus,
              url: matchedUrl,
              responseText
            })
          );
        } catch (error) {
          finish(() => reject(error));
        }
      }

      if (method === "Network.loadingFailed" && params.requestId === matchedRequestId) {
        finish(() => reject(new Error(params.errorText || "Network request failed")));
      }
    };

    const timeoutId = setTimeout(() => {
      finish(() => reject(new Error(timeoutMessage)));
    }, CAPTURE_TIMEOUT_MS);

    chrome.debugger.onEvent.addListener(onDebuggerEvent);
    chrome.debugger.onDetach.addListener(onDebuggerDetach);

    Promise.resolve()
      .then(trigger)
      .catch((error) => finish(() => reject(error)));
  });
}

function conversationListMatcher(responseUrl) {
  try {
    const url = new URL(responseUrl);
    return url.pathname === "/backend-api/conversations";
  } catch (_error) {
    return false;
  }
}

function conversationJsonMatcher(conversationId) {
  return (responseUrl) => {
    try {
      const url = new URL(responseUrl);
      return url.pathname === `/backend-api/conversation/${conversationId}`;
    } catch (_error) {
      return false;
    }
  };
}

async function fetchJsonInPageContext(target, path) {
  const expression = `
    (async () => {
      const res = await fetch(${JSON.stringify(path)}, {
        method: "GET",
        credentials: "include",
        headers: { "Accept": "application/json" }
      });
      const responseText = await res.text();
      return { ok: res.ok, status: res.status, url: ${JSON.stringify(path)}, responseText };
    })()
  `;
  const result = await debuggerCommand(target, "Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
  if (result.exceptionDetails) {
    throw new Error("页面上下文请求历史列表失败。");
  }
  return result.result.value;
}

function createListDiagnostics(responseText, status, url, fetchMethod) {
  return createConversationListDiagnostics(responseText, status, url, fetchMethod);
}

async function fetchConversationListByPageContext(target) {
  const allItems = [];
  const seen = new Set();
  const limit = 100;

  for (let offset = 0; offset < 10000; offset += limit) {
    const result = await fetchJsonInPageContext(
      target,
      `/backend-api/conversations?offset=${offset}&limit=${limit}&order=updated`
    );
    if (!result.ok) {
      const diagnostics = createListDiagnostics(
        result.responseText,
        result.status,
        result.url,
        "Runtime.evaluate fetch"
      );
      console.warn("[ChatGPT Obsidian Sync] conversation list request failed", diagnostics);
      throw new Error(`历史会话列表请求失败：${result.status}`);
    }

    const data = JSON.parse(result.responseText);
    const parsed = parseConversationListResponse(data);
    if (offset === 0 && parsed.conversations.length === 0) {
      const diagnostics = createListDiagnostics(
        result.responseText,
        result.status,
        result.url,
        "Runtime.evaluate fetch"
      );
      const structureError = new Error("未能从历史列表响应中解析到 conversation_id");
      structureError.diagnostics = diagnostics;
      throw structureError;
    }
    for (const item of parsed.conversations) {
      const id = String(item.conversation_id || "");
      if (id && !seen.has(id)) {
        seen.add(id);
        allItems.push(item);
      }
    }

    const total = Number(data.total || data.total_count || 0);
    if (parsed.conversations.length < limit || (total > 0 && allItems.length >= total)) {
      break;
    }
  }

  return {
    ok: true,
    status: 200,
    url: "/backend-api/conversations",
    responseText: JSON.stringify({ items: allItems })
  };
}

async function captureConversationListFromTab(tab, target, baseOrigin) {
  try {
    return await fetchConversationListByPageContext(target);
  } catch (error) {
    bulkState.recentError = `历史列表主动请求失败，改用 Network 捕获：${String(
      error && error.message ? error.message : error
    )}`;
    return captureNetworkResponse(
      target,
      tab.id,
      conversationListMatcher,
      () => chrome.tabs.update(tab.id, { url: `${baseOrigin}/` }),
      "未捕获到历史会话列表。请确认 ChatGPT 侧边栏已正常加载，稍后手动重试。"
    );
  }
}

async function captureConversationList(baseOrigin) {
  const backgroundTab = await createBackgroundTab("about:blank");
  bulkBackgroundTabId = backgroundTab.id;
  const target = await createDebuggerSession(backgroundTab.id);
  bulkSessionTarget = target;

  try {
    await chrome.tabs.update(backgroundTab.id, { url: `${baseOrigin}/` });
    await waitForTabComplete(backgroundTab.id, 10000);
    return await captureConversationListFromTab(backgroundTab, target, baseOrigin);
  } finally {
    await detachDebuggerSession(target);
    bulkSessionTarget = null;
    await closeBackgroundTab(backgroundTab.id);
    if (bulkBackgroundTabId === backgroundTab.id) {
      bulkBackgroundTabId = null;
    }
  }
}

async function captureConversationResponseInBackgroundTab(conversationUrl, conversationId) {
  const backgroundTab = await createBackgroundTab("about:blank");
  const target = await createDebuggerSession(backgroundTab.id);
  bulkBackgroundTabId = backgroundTab.id;

  try {
    const result = await captureNetworkResponse(
      target,
      backgroundTab.id,
      conversationJsonMatcher(conversationId),
      () => chrome.tabs.update(backgroundTab.id, { url: conversationUrl }),
      "未捕获到会话数据。请确认当前页面是普通 ChatGPT 会话页，稍后手动重试。"
    );
    if (!result.ok) {
      throw new Error(`会话请求失败：${result.status}`);
    }
    return result.responseText;
  } finally {
    await detachDebuggerSession(target);
    await closeBackgroundTab(backgroundTab.id);
    if (bulkBackgroundTabId === backgroundTab.id) {
      bulkBackgroundTabId = null;
    }
  }
}

async function captureConversationJsonForBulk(conversationId, baseOrigin) {
  const responseText = await captureConversationResponseInBackgroundTab(
    `${baseOrigin}/c/${conversationId}`,
    conversationId
  );
  return {
    ok: true,
    status: 200,
    url: `${baseOrigin}/backend-api/conversation/${conversationId}`,
    responseText
  };
}

async function enableRealtimeSyncForTab(tab, enabled) {
  if (!enabled) {
    await clearActiveRealtimeSession("stopped");
    return null;
  }
  const started = await startRealtimeSessionForTab(tab);
  return started.session;
}

async function startRealtimeSessionForTab(tab) {
  if (!tab || !tab.id) {
    throw new Error("没有找到当前标签页。");
  }
  const conversationId = getConversationId(tab.url || "");
  if (!conversationId) {
    throw new Error("当前页面不是普通 ChatGPT 会话页，请打开 https://chatgpt.com/c/<conversation_id>。");
  }
  await ensureContentScript(tab);
  const session = createActiveRealtimeSession(tab, conversationId);
  await storageSet({
    realtimeSyncEnabled: true,
    activeRealtimeSession: session,
    realtimeStatus: {
      enabled: true,
      state: "running",
      message: "实时同步已开启",
      lastConversationId: conversationId,
      lastError: "",
      updatedAt: new Date().toISOString()
    }
  });
  const stored = await storageGet(["activeRealtimeSession"]);
  if (
    !stored.activeRealtimeSession ||
    stored.activeRealtimeSession.enabled !== true ||
    stored.activeRealtimeSession.tabId !== tab.id ||
    stored.activeRealtimeSession.conversationId !== conversationId
  ) {
    await clearActiveRealtimeSession("start_failed");
    throw new Error("实时同步启动失败：activeRealtimeSession 未正确写入 storage。");
  }
  const ack = await notifyRealtimeSessionTab(session, true);
  if (
    !ack ||
    ack.ok !== true ||
    ack.timerRunning !== true ||
    ack.conversationId !== conversationId
  ) {
    await clearActiveRealtimeSession("start_failed");
    throw new Error(
      `实时同步启动失败：content timer did not start。${ack && ack.error ? ack.error : ""}`
    );
  }
  return { session, ack };
}

async function runFullCalibrationForTab(tab, conversationId) {
  const responseText = await captureConversationResponseInBackgroundTab(
    tab.url || "",
    conversationId
  );
  const summary = summarizeConversationResponse(responseText);
  console.info("[ChatGPT Obsidian Sync] calibrated conversation", summary);
  const result = await postConversationJson(responseText);
  return { result, summary };
}

async function recalibrateCurrentConversation() {
  if (taskState.status === "running") {
    throw new Error("已有同步任务正在运行。");
  }
  const tab = await getActiveTab();
  if (!tab || !tab.id) {
    throw new Error("没有找到当前标签页。");
  }
  const conversationId = getConversationId(tab.url || "");
  if (!conversationId) {
    throw new Error("当前页面不是普通 ChatGPT 会话页，请打开 https://chatgpt.com/c/<conversation_id>。");
  }
  const service = await checkService();
  if (!service.connected) {
    throw new Error("本地同步器未连接，请先启动 http://127.0.0.1:8765/。");
  }
  startTask("recalibrate-current", {
    title: conversationId,
    current: 0,
    total: 1
  });
  try {
    const { result, summary } = await runFullCalibrationForTab(tab, conversationId);
    updateTaskState({
      type: "recalibrate-current",
      status: "success",
      current: 1,
      total: 1,
      title: summary.title || result.title || conversationId,
      success: result.imported_messages || 0,
      skipped: result.skipped_messages || 0,
      failed: 0,
      lastError: "",
      suggestion: ""
    });
    return {
      ...result,
      baseline_status: await getConversationStatus(conversationId)
    };
  } catch (error) {
    const message = String(error && error.message ? error.message : error);
    updateTaskState({
      type: "recalibrate-current",
      status: "failed",
      current: 0,
      total: 1,
      title: conversationId,
      failed: 1,
      lastError: message,
      suggestion: getSuggestionForError(message)
    });
    throw error;
  }
}

async function regenerateCurrentConversationNotes() {
  if (taskState.status === "running") {
    throw new Error("已有同步任务正在运行。");
  }
  const tab = await getActiveTab();
  if (!tab || !tab.id) {
    throw new Error("没有找到当前标签页。");
  }
  const conversationId = getConversationId(tab.url || "");
  if (!conversationId) {
    throw new Error("当前页面不是普通 ChatGPT 会话页，请打开 https://chatgpt.com/c/<conversation_id>。");
  }
  const service = await checkService();
  if (!service.connected) {
    throw new Error("本地同步器未连接，请先启动 http://127.0.0.1:8765/。");
  }
  startTask("regenerate-notes", {
    title: "重新生成当前会话笔记",
    current: 0,
    total: 1
  });
  try {
    const result = await regenerateConversationNotes(conversationId);
    updateTaskState({
      type: "regenerate-notes",
      status: result.exported ? "success" : "failed",
      current: 1,
      total: 1,
      title: result.output_folder || conversationId,
      success: result.updated_files ? result.updated_files.length : 0,
      failed: result.exported ? 0 : 1,
      lastError: result.export_error || "",
      suggestion: result.exported ? "" : "数据库已有消息，但 Markdown 导出失败，请检查 OneDrive/Obsidian 文件占用。"
    });
    return result;
  } catch (error) {
    const message = String(error && error.message ? error.message : error);
    updateTaskState({
      type: "regenerate-notes",
      status: "failed",
      current: 0,
      total: 1,
      title: conversationId,
      failed: 1,
      lastError: message,
      suggestion: "请检查本地服务、Vault 路径以及 OneDrive/Obsidian 是否占用文件。"
    });
    throw error;
  }
}

async function startSyncCurrentConversation() {
  if (taskState.status === "running") {
    throw new Error("已有同步任务正在运行。");
  }
  const tab = await getActiveTab();
  if (!tab || !tab.id) {
    throw new Error("没有找到当前标签页。");
  }
  const conversationId = getConversationId(tab.url || "");
  if (!conversationId) {
    throw new Error("当前页面不是普通 ChatGPT 会话页，请打开 https://chatgpt.com/c/<conversation_id>。");
  }
  const service = await checkService();
  if (!service.connected) {
    throw new Error("本地同步器未连接，请先启动 http://127.0.0.1:8765/。");
  }

  const status = await getConversationStatus(conversationId);
  if (!status.has_full_snapshot) {
    startTask("sync-current", {
      title: "正在完整导出当前会话，建立本地基线",
      current: 0,
      total: 1
    });
    try {
      const { result, summary } = await runFullCalibrationForTab(tab, conversationId);
      const baselineStatus = await getConversationStatus(conversationId);
      if (!baselineStatus.has_full_snapshot) {
        throw new Error("完整基线建立失败：服务端未确认 has_full_snapshot=true。");
      }
      await enableRealtimeSyncForTab(tab, true);
      updateTaskState({
        type: "sync-current",
        status: "success",
        current: 1,
        total: 1,
        title: summary.title || result.title || conversationId,
        success: result.imported_messages || 0,
        skipped: result.skipped_messages || 0,
        failed: 0,
        lastError: "",
        suggestion: "完整基线已建立，实时同步已开启。"
      });
      return {
        mode: "baseline-created",
        realtime_enabled: true,
        baseline_status: baselineStatus,
        ...result
      };
    } catch (error) {
      const message = String(error && error.message ? error.message : error);
      updateTaskState({
        type: "sync-current",
        status: "failed",
        current: 0,
        total: 1,
        title: conversationId,
        failed: 1,
        lastError: message,
        suggestion: getSuggestionForError(message)
      });
      throw error;
    }
  }

  startTask("sync-current", {
    title: "启动当前会话实时同步",
    current: 1,
    total: 1
  });
  await enableRealtimeSyncForTab(tab, true);
  updateTaskState({
    type: "sync-current",
    status: "success",
    title: conversationId,
    success: status.message_count || 0,
    lastError: "",
    suggestion: status.needs_recalibration
      ? "实时同步已开启；后台将重新校准完整基线。"
      : "实时同步已开启。"
  });

  if (status.needs_recalibration) {
    runFullCalibrationForTab(tab, conversationId)
      .then(() => getConversationStatus(conversationId))
      .then((baselineStatus) => {
        updateTaskState({
          type: "sync-current",
          status: "success",
          title: conversationId,
          success: baselineStatus.message_count || status.message_count || 0,
          suggestion: "实时同步已开启，完整基线已重新校准。"
        });
      })
      .catch((error) => {
        updateTaskState({
          type: "sync-current",
          status: "failed",
          title: conversationId,
          lastError: String(error && error.message ? error.message : error),
          suggestion: getSuggestionForError(error && error.message ? error.message : error)
        });
      });
  }

  return {
    mode: status.needs_recalibration ? "realtime-started-recalibrating" : "realtime-started",
    realtime_enabled: true,
    baseline_status: status
  };
}

async function stopRealtimeSync() {
  await clearActiveRealtimeSession("stopped");
  updateTaskState({
    type: "sync-current",
    status: "stopped",
    title: "当前会话实时同步",
    lastError: "",
    suggestion: "实时同步已停止。"
  });
  return { realtime_enabled: false };
}

function extractConversationList(responseText) {
  let data;
  try {
    data = JSON.parse(responseText);
  } catch (error) {
    const diagnostics = createListDiagnostics(responseText, 0, "", "parse");
    console.warn("[ChatGPT Obsidian Sync] conversation list parse failed", diagnostics);
    const parseError = new Error(`历史会话列表 JSON 解析失败：${error.message}`);
    parseError.diagnostics = diagnostics;
    throw parseError;
  }

  const parsed = parseConversationListResponse(data);
  if (parsed.conversations.length === 0) {
    const diagnostics = createListDiagnostics(responseText, 200, "", "extractConversationList");
    console.warn("[ChatGPT Obsidian Sync] conversation list structure not recognized", diagnostics);
    const structureError = new Error("未能从历史列表响应中解析到 conversation_id");
    structureError.diagnostics = diagnostics;
    throw structureError;
  }

  return parsed.conversations;
}

function isBlockingChatGPTFailure(result) {
  const text = String(result.responseText || "").toLowerCase();
  return (
    [401, 403, 429].includes(result.status) ||
    text.includes("rate_limit") ||
    text.includes("captcha") ||
    text.includes("verification") ||
    text.includes("verify") ||
    text.includes("too many requests")
  );
}

function getSuggestionForError(errorText) {
  const text = String(errorText || "");
  if (text.includes("历史") || text.includes("列表") || text.includes("response keys")) {
    return "建议先尝试导出当前会话，或查看 popup 中的历史列表结构摘要。";
  }
  if (text.includes("未捕获到会话数据")) {
    return "建议确认当前页面是普通 ChatGPT 会话页，或稍后重试。";
  }
  if (text.includes("验证") || text.includes("受限") || text.includes("429")) {
    return "ChatGPT 可能要求验证或限制访问，请停止导出并稍后重试。";
  }
  return "建议稍后手动重试；如果持续失败，请打开扩展调试日志查看结构摘要。";
}

function diagnosticsFromError(error) {
  return error && error.diagnostics ? error.diagnostics : null;
}

async function waitForBulkInterval(seconds) {
  for (let remaining = seconds; remaining > 0; remaining -= 1) {
    if (bulkState.stopRequested) return;
    bulkState.waitingSeconds = remaining;
    updateTaskState({ waitingSeconds: remaining });
    await delay(1000);
  }
  bulkState.waitingSeconds = 0;
  updateTaskState({ waitingSeconds: 0 });
}

async function startBulkImport(options) {
  if (bulkState.running) {
    throw new Error("批量导出正在运行。");
  }
  if (taskState.status === "running") {
    throw new Error("已有导出任务正在运行。");
  }

  const safeMode = await getSafeMode();
  if (safeMode) {
    throw new Error("请先切换到高级模式，再扫描历史会话列表。");
  }

  const tab = await getActiveTab();
  if (!tab || !tab.id || !isSupportedChatPage(tab.url || "")) {
    throw new Error("请先打开普通 ChatGPT 会话页，再启动批量导出。");
  }

  const service = await checkService();
  if (!service.connected) {
    throw new Error("本地同步器未连接，请先启动 http://127.0.0.1:8765/。");
  }

  const bulkOptions = normalizeBulkOptions(options || {});
  await storageSet({
    advancedImportIntervalSeconds: bulkOptions.bulkIntervalSeconds,
    advancedMaxBulkConversations: bulkOptions.bulkMaxCount,
    advancedImportAll: bulkOptions.bulkUseAll
  });
  bulkState = {
    ...createIdleBulkState(),
    ...bulkOptions,
    mode: "running",
    running: true
  };
  bulkState.mode = "running";
  startTask("bulk-import", {
    title: "批量导出历史会话",
    waitingSeconds: 0
  });

  let prepared;
  try {
    prepared = await prepareBulkImport(tab, bulkOptions);
  } catch (error) {
    const message = String(error && error.message ? error.message : error);
    bulkState.mode = "failed";
    bulkState.running = false;
    bulkState.recentError = message;
    updateTaskState({
      type: "bulk-import",
      status: "failed",
      lastError: message,
      suggestion: getSuggestionForError(message),
      diagnostics: diagnosticsFromError(error)
    });
    throw error;
  }

  runBulkImport(prepared.baseOrigin, prepared.selectedConversations).catch((error) => {
    if (bulkState.stopRequested) {
      bulkState.mode = "stopped";
      bulkState.recentError = "批量导出已停止。";
      updateTaskState({
        type: "bulk-import",
        status: "stopped",
        lastError: "批量导出已停止。",
        suggestion: "已停止后续导出，已经导出的内容会保留。",
        diagnostics: diagnosticsFromError(error)
      });
    } else {
      bulkState.mode = "failed";
      bulkState.recentError = String(error && error.message ? error.message : error);
      updateTaskState({
        type: "bulk-import",
        status: "failed",
        lastError: bulkState.recentError,
        suggestion: getSuggestionForError(bulkState.recentError),
        diagnostics: diagnosticsFromError(error)
      });
    }
    bulkState.running = false;
    bulkState.waitingSeconds = 0;
  });

  return getBulkStatus();
}

async function prepareBulkImport(tab, options) {
  const baseOrigin = new URL(tab.url).origin;
  const listResult = await captureConversationList(baseOrigin);
  if (isBlockingChatGPTFailure(listResult)) {
    throw new Error(`ChatGPT 历史列表请求受限或需要验证：${listResult.status}`);
  }
  if (!listResult.ok) {
    const diagnostics = createListDiagnostics(
      listResult.responseText,
      listResult.status,
      listResult.url,
      "Network capture"
    );
    const requestError = new Error(`历史会话列表请求失败：${listResult.status}`);
    requestError.diagnostics = diagnostics;
    throw requestError;
  }

  const allConversations = extractConversationList(listResult.responseText);
  const selectedConversations = options.bulkUseAll
    ? allConversations
    : allConversations.slice(0, options.bulkMaxCount);

  bulkState.total = selectedConversations.length;
  updateTaskState({
    total: selectedConversations.length,
    current: 0,
    title: "批量导出历史会话",
    diagnostics: null
  });
  if (bulkState.total === 0) {
    throw new Error("未能从历史列表响应中解析到 conversation_id");
  }

  return { baseOrigin, selectedConversations };
}

async function scanHistoryConversations(options) {
  if (bulkState.running || taskState.status === "running") {
    throw new Error("已有导出任务正在运行。");
  }
  const safeMode = await getSafeMode();
  if (safeMode) {
    throw new Error("请先切换到高级模式，再扫描历史会话列表。");
  }
  const tab = await getActiveTab();
  if (!tab || !tab.id || !isSupportedChatPage(tab.url || "")) {
    throw new Error("请先打开普通 ChatGPT 会话页，再扫描历史会话列表。");
  }
  const bulkOptions = normalizeBulkOptions(options || {});
  startTask("history-scan", {
    title: "扫描历史会话列表",
    current: 0,
    total: 0
  });
  try {
    const prepared = await prepareBulkImport(tab, bulkOptions);
    scannedConversations = prepared.selectedConversations;
    scannedBaseOrigin = prepared.baseOrigin;
    updateTaskState({
      type: "history-scan",
      status: "success",
      title: "历史会话列表扫描完成",
      current: scannedConversations.length,
      total: scannedConversations.length,
      success: scannedConversations.length,
      diagnostics: null
    });
    return { conversations: scannedConversations };
  } catch (error) {
    const rawMessage = String(error && error.message ? error.message : error);
    const message = rawMessage.includes("Receiving end does not exist")
      ? "安全模式当前会话导出需要页面采集能力，当前版本暂不可用。请切换高级模式使用完整导出。"
      : rawMessage;
    updateTaskState({
      type: "history-scan",
      status: "failed",
      title: "扫描历史会话列表",
      lastError: message,
      suggestion: getSuggestionForError(message),
      diagnostics: diagnosticsFromError(error)
    });
    throw error;
  }
}

async function startSelectedBulkImport(options) {
  if (bulkState.running || taskState.status === "running") {
    throw new Error("已有导出任务正在运行。");
  }
  const safeMode = await getSafeMode();
  if (safeMode) {
    throw new Error("请先切换到高级模式，再导出历史会话。");
  }
  const selectedIds = Array.isArray(options && options.selectedConversationIds)
    ? options.selectedConversationIds.map(String)
    : [];
  if (selectedIds.length === 0) {
    throw new Error("请先选择至少一个会话。");
  }
  const selectedSet = new Set(selectedIds);
  const selectedConversations = scannedConversations.filter((item) =>
    selectedSet.has(String(item.conversation_id))
  );
  if (selectedConversations.length === 0) {
    throw new Error("请先扫描历史会话列表并选择要导出的会话。");
  }
  const bulkOptions = normalizeBulkOptions(options || {});
  await storageSet({
    advancedImportIntervalSeconds: bulkOptions.bulkIntervalSeconds,
    advancedMaxBulkConversations: bulkOptions.bulkMaxCount,
    advancedImportAll: false
  });
  bulkState = {
    ...createIdleBulkState(),
    ...bulkOptions,
    mode: "running",
    running: true,
    total: selectedConversations.length
  };
  startTask("bulk-import", {
    title: "批量导出已选择会话",
    total: selectedConversations.length
  });
  runBulkImport(scannedBaseOrigin, selectedConversations).catch((error) => {
    if (bulkState.stopRequested) {
      bulkState.mode = "stopped";
      bulkState.recentError = "批量导出已停止。";
      updateTaskState({
        type: "bulk-import",
        status: "stopped",
        lastError: "批量导出已停止。",
        suggestion: "已停止后续导出，已经导出的内容会保留。",
        diagnostics: diagnosticsFromError(error)
      });
    } else {
      bulkState.mode = "failed";
      bulkState.recentError = String(error && error.message ? error.message : error);
      updateTaskState({
        type: "bulk-import",
        status: "failed",
        lastError: bulkState.recentError,
        suggestion: getSuggestionForError(bulkState.recentError),
        diagnostics: diagnosticsFromError(error)
      });
    }
    bulkState.running = false;
    bulkState.waitingSeconds = 0;
  });
  return getBulkStatus();
}

async function runBulkImport(baseOrigin, selectedConversations) {
  try {
    for (let index = 0; index < selectedConversations.length; index += 1) {
      if (bulkState.stopRequested) break;

      const item = selectedConversations[index];
      bulkState.index = index + 1;
      bulkState.currentTitle = item.title;
      bulkState.currentConversationId = item.conversation_id;
      bulkState.waitingSeconds = 0;
      updateTaskState({
        type: "bulk-import",
        status: "running",
        current: index + 1,
        total: selectedConversations.length,
          title: item.title,
          success: bulkState.success,
          failed: bulkState.failed,
          skipped: bulkState.skipped,
          waitingSeconds: 0,
          lastError: bulkState.recentError,
          diagnostics: null
        });

      try {
        const conversationResult = await captureConversationJsonForBulk(
          item.conversation_id,
          baseOrigin
        );
        if (isBlockingChatGPTFailure(conversationResult)) {
          throw new Error(`ChatGPT 会话请求受限或需要验证：${conversationResult.status}`);
        }
        if (!conversationResult.ok) {
          throw new Error(`会话请求失败：${conversationResult.status}`);
        }

        const importResult = await postConversationJson(conversationResult.responseText);
        if (
          (importResult.imported_messages || 0) === 0 &&
          (importResult.updated_messages || 0) === 0
        ) {
          bulkState.skipped += 1;
        } else {
          bulkState.success += 1;
        }
        updateTaskState({
          success: bulkState.success,
          skipped: bulkState.skipped,
          failed: bulkState.failed,
          lastError: bulkState.recentError
        });
      } catch (error) {
        bulkState.failed += 1;
        bulkState.recentError = `${item.title}: ${String(error && error.message ? error.message : error)}`;
        updateTaskState({
          failed: bulkState.failed,
          lastError: bulkState.recentError,
          suggestion: getSuggestionForError(bulkState.recentError)
        });
      }

      if (index < selectedConversations.length - 1) {
        await waitForBulkInterval(bulkState.bulkIntervalSeconds);
      }
    }

    bulkState.mode = bulkState.stopRequested ? "stopped" : "completed";
    bulkState.running = false;
    bulkState.waitingSeconds = 0;
    updateTaskState({
      type: "bulk-import",
      status: bulkState.stopRequested ? "stopped" : "success",
      current: bulkState.index,
      total: bulkState.total,
      title: bulkState.currentTitle || "批量导出历史会话",
      success: bulkState.success,
      failed: bulkState.failed,
      skipped: bulkState.skipped,
      waitingSeconds: 0,
      lastError: bulkState.recentError,
      suggestion: bulkState.stopRequested ? "已停止后续导出，已经导出的内容会保留。" : ""
    });
  } finally {
    bulkSessionTarget = null;
    await closeBackgroundTab(bulkBackgroundTabId);
    if (bulkState.stopRequested) {
      bulkState.mode = "stopped";
      bulkState.running = false;
      bulkState.waitingSeconds = 0;
      updateTaskState({
        type: "bulk-import",
        status: "stopped",
        lastError: "批量导出已停止。",
        suggestion: "已停止后续导出，已经导出的内容会保留。"
      });
    }
  }
}

async function getStatus() {
  const tab = await getActiveTab();
  const conversationId = tab ? getConversationId(tab.url || "") : null;
  const service = await checkService();
  const safeMode = await getSafeMode();
  const advancedCooldownSeconds = await getAdvancedCooldownSeconds();
  const activeRealtimeSession = await getActiveRealtimeSession();
  return {
    serviceConnected: service.connected,
    serviceError: service.error || "",
    tabUrl: tab ? tab.url || "" : "",
    conversationId,
    supported: Boolean(tab && isSupportedChatPage(tab.url || "")),
    activeTabId: tab ? tab.id || null : null,
    activeRealtimeSession,
    safeMode,
    advancedCooldownSeconds,
    cooldownSeconds: Math.ceil(
      (safeMode ? IMPORT_COOLDOWN_MS : advancedCooldownSeconds * 1000) / 1000
    )
  };
}

async function reconcileRealtimeSessionForActiveTab() {
  const session = await getActiveRealtimeSession();
  if (!session) {
    return { cleared: false, activeRealtimeSession: null };
  }
  const tab = await getActiveTab();
  if (!tab || session.tabId !== tab.id) {
    await stopRealtimeSessionBecause("stopped_due_to_conversation_changed");
    return {
      cleared: true,
      reason: "tab_mismatch",
      activeTabId: tab ? tab.id : null,
      sessionTabId: session.tabId
    };
  }
  const activeConversationId = tab ? getConversationId(tab.url || "") : null;
  if (activeConversationId && activeConversationId !== session.conversationId) {
    await stopRealtimeSessionBecause("stopped_due_to_conversation_changed");
    return {
      cleared: true,
      reason: "conversation_mismatch",
      activeConversationId,
      sessionConversationId: session.conversationId
    };
  }
  return { cleared: false, activeRealtimeSession: session };
}

async function exportCurrentConversationSafe(tab, conversationId) {
  startTask("import-current", {
    title: conversationId,
    current: 0,
    total: 1
  });
  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: "exportVisibleConversation" });
    if (!response || response.ok === false) {
      throw new Error(
        response && response.error
          ? response.error
          : "安全模式当前会话导出需要页面采集能力，当前版本暂不可用。请切换高级模式使用完整导出。"
      );
    }
    const result = response.data || {};
    updateTaskState({
      type: "import-current",
      status: "success",
      current: 1,
      total: 1,
      title: result.title || conversationId,
      success: result.exported_messages || 0,
      failed: 0,
      lastError: "",
      suggestion: ""
    });
    return {
      conversation_id: result.conversation_id || conversationId,
      title: result.title || "",
      imported_messages: result.exported_messages || 0,
      updated_messages: 0,
      skipped_messages: 0
    };
  } catch (error) {
    const message = String(error && error.message ? error.message : error);
    updateTaskState({
      type: "import-current",
      status: "failed",
      current: 0,
      total: 1,
      title: conversationId,
      failed: 1,
      lastError: message,
      suggestion: getSuggestionForError(message)
    });
    throw new Error(message);
  }
}

async function importCurrentConversation() {
  if (taskState.status === "running") {
    throw new Error("已有导出任务正在运行。");
  }
  const tab = await getActiveTab();
  if (!tab || !tab.id) {
    throw new Error("没有找到当前标签页。");
  }

  const conversationId = getConversationId(tab.url || "");
  if (!conversationId) {
    throw new Error("当前页面不是普通 ChatGPT 会话页，请打开 https://chatgpt.com/c/<conversation_id>。");
  }

  const service = await checkService();
  if (!service.connected) {
    throw new Error("本地同步器未连接，请先启动 http://127.0.0.1:8765/。");
  }

  const safeMode = await getSafeMode();
  const advancedCooldownSeconds = await getAdvancedCooldownSeconds();
  await enforceImportCooldown(Date.now(), safeMode, advancedCooldownSeconds);
  if (safeMode) {
    return exportCurrentConversationSafe(tab, conversationId);
  }
  startTask("import-current", {
    title: conversationId,
    current: 0,
    total: 1
  });

  try {
    const responseText = await captureConversationResponseInBackgroundTab(tab.url || "", conversationId);
    const summary = summarizeConversationResponse(responseText);
    updateTaskState({
      title: summary.title || conversationId,
      current: 1,
      total: 1
    });
    console.info("[ChatGPT Obsidian Sync] captured conversation", summary);
    const result = await postConversationJson(responseText);
    updateTaskState({
      type: "import-current",
      status: "success",
      current: 1,
      total: 1,
      title: result.title || summary.title || conversationId,
      success: result.imported_messages || 0,
      skipped: result.skipped_messages || 0,
      failed: 0,
      lastError: "",
      suggestion: ""
    });
    return result;
  } catch (error) {
    const message = String(error && error.message ? error.message : error);
    updateTaskState({
      type: "import-current",
      status: "failed",
      current: 0,
      total: 1,
      title: conversationId,
      failed: 1,
      lastError: message,
      suggestion: getSuggestionForError(message)
    });
    throw error;
  }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.url && changeInfo.status !== "complete") {
    return;
  }
  getActiveRealtimeSession()
    .then((session) => {
      if (!session || session.tabId !== tabId) {
        return;
      }
      const pageUrl = changeInfo.url || tab?.url || "";
      const conversationId = getConversationId(pageUrl);
      if (!conversationId || conversationId !== session.conversationId) {
        return stopRealtimeSessionBecause("stopped_due_to_conversation_changed");
      }
      return undefined;
    })
    .catch(() => undefined);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  getActiveRealtimeSession()
    .then((session) => {
      if (session && session.tabId === tabId) {
        return stopRealtimeSessionBecause("stopped_due_to_conversation_changed");
      }
      return undefined;
    })
    .catch(() => undefined);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const run = async () => {
    if (message && message.type === "getStatus") {
      return getStatus();
    }
    if (message && message.type === "importCurrentConversation") {
      return importCurrentConversation();
    }
    if (message && message.type === "startSyncCurrentConversation") {
      return startSyncCurrentConversation();
    }
    if (message && message.type === "stopRealtimeSync") {
      return stopRealtimeSync();
    }
    if (message && message.type === "reconcileRealtimeSession") {
      return reconcileRealtimeSessionForActiveTab();
    }
    if (message && message.type === "recalibrateCurrentConversation") {
      return recalibrateCurrentConversation();
    }
    if (message && message.type === "regenerateCurrentConversationNotes") {
      return regenerateCurrentConversationNotes();
    }
    if (message && message.type === "getConversationStatus") {
      return getConversationStatus(message.conversationId || "");
    }
    if (message && message.type === "setSafeMode") {
      const safeMode = await setSafeMode(message.safeMode);
      return { safeMode };
    }
    if (message && message.type === "setAdvancedCooldownSeconds") {
      const advancedCooldownSeconds = await setAdvancedCooldownSeconds(
        message.advancedCooldownSeconds
      );
      return { advancedCooldownSeconds };
    }
    if (message && message.type === "getBulkStatus") {
      return getBulkStatus();
    }
    if (message && message.type === "getTaskState") {
      return getTaskState();
    }
    if (message && message.type === "scanHistoryConversations") {
      return scanHistoryConversations(message.options || {});
    }
    if (message && message.type === "startSelectedBulkImport") {
      return startSelectedBulkImport(message.options || {});
    }
    if (message && message.type === "startBulkImport") {
      return startSelectedBulkImport(message.options || {});
    }
    if (message && message.type === "stopBulkImport") {
      return stopBulkImport();
    }
    throw new Error("Unknown message type");
  };

  run()
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) =>
      sendResponse({
        ok: false,
        error: String(error && error.message ? error.message : error)
      })
    );
  return true;
});
