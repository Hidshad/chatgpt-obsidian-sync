const serviceEl = document.getElementById("service");
const conversationEl = document.getElementById("conversation");
const supportedEl = document.getElementById("supported");
const activeTabUrlEl = document.getElementById("active-tab-url");
const popupConversationEl = document.getElementById("popup-conversation");
const contentConversationEl = document.getElementById("content-conversation");
const conversationMismatchEl = document.getElementById("conversation-mismatch");
const importButton = document.getElementById("import-button");
const stopRealtimeButton = document.getElementById("stop-realtime-button");
const regenerateNotesButton = document.getElementById("regenerate-notes-button");
const recalibrateButton = document.getElementById("recalibrate-button");
const importModeHelp = document.getElementById("import-mode-help");
const baselineStatusEl = document.getElementById("baseline-status");
const baselineMessageCountEl = document.getElementById("baseline-message-count");
const baselineFullAtEl = document.getElementById("baseline-full-at");
const baselineRealtimeAtEl = document.getElementById("baseline-realtime-at");
const syncSourceEl = document.getElementById("sync-source");
const fullExportMessageCountEl = document.getElementById("full-export-message-count");
const mappingNodeCountEl = document.getElementById("mapping-node-count");
const candidateMessageNodeCountEl = document.getElementById("candidate-message-node-count");
const partCountEl = document.getElementById("part-count");
const exportedSectionCountEl = document.getElementById("exported-section-count");
const orderIssueCountEl = document.getElementById("order-issue-count");
const lastExportedTextPreviewEl = document.getElementById("last-exported-text-preview");
const parserWarningEl = document.getElementById("parser-warning");
const baselineSection = document.getElementById("baseline-section");
const taskSection = document.getElementById("task-section");
const modeNotice = document.getElementById("mode-notice");
const modeNameEl = document.getElementById("mode-name");
const modeDescriptionEl = document.getElementById("mode-description");
const modeToggle = document.getElementById("mode-toggle");
const advancedModeSettings = document.getElementById("advanced-mode-settings");
const advancedCooldownInput = document.getElementById("advanced-cooldown-seconds");
const advancedCurrentSection = document.getElementById("advanced-current-section");
const developerBulkSection = document.getElementById("developer-bulk-section");
const bulkIntervalSecondsInput = document.getElementById("bulk-interval-seconds");
const bulkIntervalWarning = document.getElementById("bulk-interval-warning");
const bulkMaxCountInput = document.getElementById("bulk-max-count");
const bulkUseAll = document.getElementById("bulk-use-all");
const bulkConfirmed = document.getElementById("bulk-confirmed");
const bulkScanButton = document.getElementById("bulk-scan-button");
const bulkSelectAllButton = document.getElementById("bulk-select-all-button");
const bulkExportSelectedButton = document.getElementById("bulk-export-selected-button");
const bulkStopButton = document.getElementById("bulk-stop-button");
const bulkProgressEl = document.getElementById("bulk-progress");
const bulkListEl = document.getElementById("bulk-list");
const taskStatusEl = document.getElementById("task-status");
const taskTitleEl = document.getElementById("task-title");
const taskProgressEl = document.getElementById("task-progress");
const taskErrorEl = document.getElementById("task-error");
const taskSuggestionEl = document.getElementById("task-suggestion");
const historyDiagnosticsEl = document.getElementById("history-diagnostics");
const diagnosticsUrlEl = document.getElementById("diagnostics-url");
const diagnosticsStatusEl = document.getElementById("diagnostics-status");
const diagnosticsSizeEl = document.getElementById("diagnostics-size");
const diagnosticsTopLevelKeysEl = document.getElementById("diagnostics-top-level-keys");
const diagnosticsCandidatePathsEl = document.getElementById("diagnostics-candidate-paths");
const diagnosticsCandidateLengthsEl = document.getElementById("diagnostics-candidate-lengths");
const diagnosticsFirstItemKeysEl = document.getElementById("diagnostics-first-item-keys");
const diagnosticsPreviewEl = document.getElementById("diagnostics-preview");
const realtimeStateEl = document.getElementById("realtime-state");
const realtimeToggle = document.getElementById("realtime-toggle");
const realtimeIntervalSecondsInput = document.getElementById("realtime-interval-seconds");
const realtimeContentScriptEl = document.getElementById("realtime-content-script");
const realtimeLastSyncEl = document.getElementById("realtime-last-sync");
const realtimeMessageCountEl = document.getElementById("realtime-message-count");
const realtimeConversationIdEl = document.getElementById("realtime-conversation-id");
const realtimeErrorEl = document.getElementById("realtime-error");
const realtimeSection = document.getElementById("realtime-section");
const realtimeWriteCountsEl = document.getElementById("realtime-write-counts");
const realtimeDbCountEl = document.getElementById("realtime-db-count");
const realtimeExportedEl = document.getElementById("realtime-exported");
const realtimeOutputFolderEl = document.getElementById("realtime-output-folder");
const realtimeUpdatedFilesEl = document.getElementById("realtime-updated-files");
const realtimeLastSuccessfulExportEl = document.getElementById("realtime-last-successful-export");
const realtimeExportErrorEl = document.getElementById("realtime-export-error");
const realtimeAdvancedDiagnosticsEl = document.getElementById("realtime-advanced-diagnostics");
const messageEl = document.getElementById("message");

const DEFAULT_REALTIME_SYNC_ENABLED = false;
const DEFAULT_REALTIME_SYNC_INTERVAL_SECONDS = 30;
const MIN_REALTIME_SYNC_INTERVAL_SECONDS = 10;
const MAX_REALTIME_SYNC_INTERVAL_SECONDS = 300;
const DEFAULT_SAFE_MODE = true;
const DEFAULT_ADVANCED_COOLDOWN_SECONDS = 20;
const DEFAULT_ADVANCED_IMPORT_INTERVAL_SECONDS = 20;
const DEFAULT_ADVANCED_MAX_BULK_CONVERSATIONS = 20;
const parseConversationIdFromUrl = ChatGptObsidianUrl.parseConversationIdFromUrl;
const CONVERSATION_MISMATCH_MESSAGE =
  "当前标签页 URL 解析结果与 content script 报告不一致，请刷新页面或重新加载扩展。";

let bulkPollTimer = null;
let realtimePollTimer = null;
let taskPollTimer = null;
let scannedConversations = [];

function setMessage(text, kind) {
  messageEl.textContent = text || "";
  messageEl.className = kind ? `message ${kind}` : "message";
}

function sendMessage(message) {
  return chrome.runtime.sendMessage(message);
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
}

async function getActiveConversationSnapshot() {
  const tab = await getActiveTab();
  const conversationId = tab ? parseConversationIdFromUrl(tab.url || "") : "";
  return { tab, conversationId: conversationId || "" };
}

function normalizeRealtimeIntervalSeconds(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) {
    return DEFAULT_REALTIME_SYNC_INTERVAL_SECONDS;
  }
  return Math.max(MIN_REALTIME_SYNC_INTERVAL_SECONDS, Math.min(MAX_REALTIME_SYNC_INTERVAL_SECONDS, Math.round(seconds)));
}

async function sendRealtimeMessageToActiveTab(message) {
  const tab = await getActiveTab();
  if (!tab || !tab.id) {
    return { ok: false, error: "No active tab" };
  }
  const conversationId = parseConversationIdFromUrl(tab.url || "");
  if (!conversationId) {
    // 不向非会话页发送实时同步消息，避免打扰 ChatGPT 首页、订阅页或设置页。
    return { ok: false, error: "当前不是普通 ChatGPT 会话页" };
  }
  try {
    return await chrome.tabs.sendMessage(tab.id, message);
  } catch (error) {
    return {
      ok: false,
      error: String(error && error.message ? error.message : error),
    };
  }
}

function shortenUrl(url) {
  const value = String(url || "");
  return value.length > 72 ? `${value.slice(0, 48)}...${value.slice(-18)}` : value || "未知";
}

async function getContentScriptSnapshot() {
  const { conversationId } = await getActiveConversationSnapshot();
  if (!conversationId) {
    return { loaded: false, conversationId: "", pageType: "non_conversation" };
  }
  const response = await sendRealtimeMessageToActiveTab({
    type: "CHATGPT_OBSIDIAN_PING",
  });
  if (!response || !response.ok || !response.contentScriptLoaded) {
    return {
      loaded: false,
      conversationId: "",
      error: response && response.error ? response.error : "current tab ping failed",
    };
  }
  return {
    loaded: true,
    conversationId: response.conversationId || "",
    activeConversationId: response.activeConversationId || "",
    timerRunning: response.timerRunning === true,
  };
}

async function detectContentScript() {
  const snapshot = await getContentScriptSnapshot();
  return snapshot.loaded;
}

function formatRealtimeDiagnostics(diagnostics) {
  const selectorCounts = diagnostics?.selectorCounts;
  if (!selectorCounts && !diagnostics) {
    return "";
  }
  const lines = [];
  if (selectorCounts) {
    lines.push(
      `selector counts: role=${selectorCounts.role || 0}, ` +
        `turn=${selectorCounts.turnPrefix || selectorCounts.turnAny || 0}, ` +
        `article=${selectorCounts.article || 0}, ` +
        `mainArticle=${selectorCounts.mainArticle || 0}, ` +
        `bodyText=${diagnostics.bodyTextLength || 0}`
    );
  }
  if (diagnostics?.extracted_message_count !== undefined) {
    lines.push(
      `extracted: total=${diagnostics.extracted_message_count || 0}, ` +
        `user=${diagnostics.extracted_user_count || 0}, ` +
        `assistant=${diagnostics.extracted_assistant_count || 0}, ` +
        `lastRole=${diagnostics.last_extracted_role || "none"}, ` +
        `lastId=${diagnostics.last_extracted_message_id || "none"}, ` +
        `lastFallback=${diagnostics.last_extracted_is_fallback === true}, ` +
        `lastPreview=${diagnostics.last_extracted_text_preview || ""}`
    );
  }
  if (Array.isArray(diagnostics?.payload_message_ids_tail)) {
    lines.push(`payload_message_ids_tail=${diagnostics.payload_message_ids_tail.join(" | ")}`);
  }
  if (Array.isArray(diagnostics?.payload_text_previews_tail)) {
    lines.push(`payload_text_previews_tail=${diagnostics.payload_text_previews_tail.join(" | ")}`);
  }
  return lines.join("；");
}

function roleLabel(role) {
  const normalized = String(role || "").toLowerCase();
  if (normalized === "user") return "User";
  if (normalized === "assistant") return "Assistant";
  return normalized || "Unknown";
}

function renderRealtimeStatus(values) {
  const activeRealtimeSession = values.activeRealtimeSession || null;
  const activeSessionEnabled = Boolean(activeRealtimeSession && activeRealtimeSession.enabled);
  const enabled =
    activeSessionEnabled ||
    (typeof values.realtimeSyncEnabled === "boolean"
      ? values.realtimeSyncEnabled
      : DEFAULT_REALTIME_SYNC_ENABLED);
  const realtimeStatus = values.realtimeStatus || {};
  const intervalSeconds = normalizeRealtimeIntervalSeconds(
    values.realtimeSyncIntervalSeconds
  );
  const contentScriptLoaded = values.contentScriptDetected === true;
  const nonConversationPage = realtimeStatus.pageType === "non_conversation";
  const stopped = !activeSessionEnabled;
  const activeConversationId = values.activeConversationId || "";
  const statusConversationId = realtimeStatus.lastConversationId || "";
  const contentTimerRunning = realtimeStatus.timerRunning === true;
  const contentActiveConversationId = realtimeStatus.activeConversationId || statusConversationId;
  const realtimeStateConsistent =
    activeSessionEnabled &&
    contentTimerRunning &&
    activeRealtimeSession?.conversationId === activeConversationId &&
    contentActiveConversationId === activeConversationId;
  const statusBelongsToOtherConversation = Boolean(
    activeConversationId && statusConversationId && statusConversationId !== activeConversationId
  );
  const shouldHideStaleRealtimeResult =
    !realtimeStateConsistent || statusBelongsToOtherConversation;
  realtimeStateEl.textContent = realtimeStateConsistent ? "开启" : "关闭";
  realtimeToggle.textContent = realtimeStateConsistent ? "实时同步：开启" : "实时同步：关闭";
  realtimeToggle.disabled = nonConversationPage;
  stopRealtimeButton.disabled = !activeSessionEnabled;
  realtimeIntervalSecondsInput.value = String(intervalSeconds);
  realtimeContentScriptEl.textContent = contentScriptLoaded ? "已加载" : "未检测到";
  realtimeLastSyncEl.textContent = shouldHideStaleRealtimeResult
    ? "无"
    : realtimeStatus.lastSyncAt || "无";
  realtimeMessageCountEl.textContent = shouldHideStaleRealtimeResult
    ? "0"
    : String(realtimeStatus.lastMessageCount || 0);
  realtimeConversationIdEl.textContent =
    activeSessionEnabled ? activeRealtimeSession?.conversationId || "无" : "无";
  const writeResult = shouldHideStaleRealtimeResult
    ? {}
    : realtimeStatus.lastWriteResult || {};
  const lastSuccessfulExport = shouldHideStaleRealtimeResult
    ? null
    : realtimeStatus.lastSuccessfulExport || null;
  const updatedFiles = Array.isArray(writeResult.updatedFiles) ? writeResult.updatedFiles : [];
  const insertedTail = Array.isArray(writeResult.insertedTail) ? writeResult.insertedTail : [];
  realtimeWriteCountsEl.textContent =
    writeResult.receivedMessages === undefined
      ? "无"
      : `收到 ${writeResult.receivedMessages || 0} 条，新增 ${
          writeResult.insertedMessages || 0
        } 条，更新 ${writeResult.updatedMessages || 0} 条，跳过 ${
          writeResult.skippedMessages || 0
        } 条`;
  realtimeDbCountEl.textContent = String(writeResult.messageCountAfter || 0);
  realtimeExportedEl.textContent =
    writeResult.exported === true
      ? "已导出"
      : writeResult.exportAttempted
        ? "导出失败"
        : writeResult.receivedMessages !== undefined
          ? "本轮无变化，未重新导出"
          : "未导出";
  realtimeOutputFolderEl.textContent = writeResult.outputFolder || "无";
  realtimeUpdatedFilesEl.textContent = [
    updatedFiles.length ? `本轮：${updatedFiles.join("、")}` : "本轮：无",
    lastSuccessfulExport?.updatedFiles?.length
      ? `最近成功导出文件：${lastSuccessfulExport.updatedFiles.join("、")}`
      : "",
  ]
    .filter(Boolean)
    .join("；");
  realtimeLastSuccessfulExportEl.textContent = lastSuccessfulExport
    ? `最近一次成功导出：${lastSuccessfulExport.at || "无"}；最后导出消息：[${
        roleLabel(lastSuccessfulExport.lastRole)
      }] ${lastSuccessfulExport.lastTextPreview || ""}；所在文件：${
        lastSuccessfulExport.lastPartFilename || "无"
      }；order_index：${lastSuccessfulExport.lastOrderIndex ?? "无"}`
    : "无";
  const orderDiagnosticText =
    writeResult.maxOrderIndexAfter === undefined || writeResult.maxOrderIndexAfter === null
      ? "无"
      : `order ${writeResult.maxOrderIndexBefore ?? "?"} -> ${
          writeResult.maxOrderIndexAfter
        }；inserted=${(writeResult.insertedOrderIndexes || []).join(",") || "none"}；updated=${
          (writeResult.updatedOrderIndexes || []).join(",") || "none"
        }；skippedTail=${(writeResult.skippedMessageIdsTail || []).join(",") || "none"}`;
  realtimeExportErrorEl.textContent = writeResult.exportError
    ? `数据库已更新，但 Markdown 导出失败：${writeResult.exportError}`
    : "无";
  const diagnosticText = formatRealtimeDiagnostics(realtimeStatus.diagnostics);
  realtimeAdvancedDiagnosticsEl.textContent = [
    orderDiagnosticText,
    insertedTail.length
      ? `本轮新增：${insertedTail
          .map((item) => `[${roleLabel(item.role)}] ${item.preview || ""}`)
          .join(" | ")}`
      : "",
    diagnosticText,
  ]
    .filter((item) => item && item !== "无")
    .join("；") || "无";
  if (enabled && !contentScriptLoaded) {
    realtimeErrorEl.textContent =
      "实时同步已开启，但当前页面未检测到 content script。请确认当前标签页是 ChatGPT 会话页，并刷新页面后重试。";
  } else if (statusBelongsToOtherConversation) {
    realtimeErrorEl.textContent = "上次实时同步来自其他会话，已隐藏。";
  } else if (activeSessionEnabled && !realtimeStateConsistent) {
    realtimeErrorEl.textContent = "实时同步状态不一致，已停止，请重新开始同步。";
  } else if (shouldHideStaleRealtimeResult) {
    realtimeErrorEl.textContent = "实时同步已停止";
  } else {
    realtimeErrorEl.textContent = [
      realtimeStatus.message || "",
      realtimeStatus.lastError || "无",
      diagnosticText,
    ]
      .filter(Boolean)
      .join("；");
  }
}

async function refreshRealtimeStatus() {
  const values = await chrome.storage.local.get([
    "realtimeSyncEnabled",
    "realtimeSyncIntervalSeconds",
    "realtimeStatus",
    "activeRealtimeSession",
  ]);
  if (typeof values.realtimeSyncEnabled !== "boolean") {
    await chrome.storage.local.set({
      realtimeSyncEnabled: DEFAULT_REALTIME_SYNC_ENABLED,
      realtimeSyncIntervalSeconds: DEFAULT_REALTIME_SYNC_INTERVAL_SECONDS,
    });
    values.realtimeSyncEnabled = DEFAULT_REALTIME_SYNC_ENABLED;
    values.realtimeSyncIntervalSeconds = DEFAULT_REALTIME_SYNC_INTERVAL_SECONDS;
  }
  const normalizedInterval = normalizeRealtimeIntervalSeconds(
    values.realtimeSyncIntervalSeconds
  );
  if (values.realtimeSyncIntervalSeconds !== normalizedInterval) {
    await chrome.storage.local.set({
      realtimeSyncIntervalSeconds: normalizedInterval,
    });
    values.realtimeSyncIntervalSeconds = normalizedInterval;
  }
  const { conversationId } = await getActiveConversationSnapshot();
  values.activeConversationId = conversationId || "";
  if (
    conversationId &&
    values.activeRealtimeSession?.enabled &&
    values.activeRealtimeSession.conversationId !== conversationId
  ) {
    await sendMessage({ type: "reconcileRealtimeSession" });
    const refreshed = await chrome.storage.local.get([
      "realtimeSyncEnabled",
      "realtimeSyncIntervalSeconds",
      "realtimeStatus",
      "activeRealtimeSession",
    ]);
    refreshed.activeConversationId = conversationId || "";
    refreshed.realtimeStatus = {
      ...(refreshed.realtimeStatus || {}),
      state: "stopped_due_to_conversation_changed",
      message: "检测到旧实时同步状态，已清理",
      lastConversationId: "",
      lastError: "实时同步会话与当前页面不一致，已停止同步。",
    };
    renderRealtimeStatus(refreshed);
    return;
  }
  if (!conversationId) {
    values.activeConversationId = "";
    values.realtimeSyncEnabled = Boolean(values.activeRealtimeSession?.enabled);
    values.contentScriptDetected = false;
    values.realtimeStatus = {
      contentScriptLoaded: false,
      pageType: "non_conversation",
      state: "standby",
      message: "当前不是普通 ChatGPT 会话页，扩展已静默待机",
      lastSyncAt: "",
      lastMessageCount: 0,
      lastConversationId: values.activeRealtimeSession?.conversationId || "",
      lastError: "当前不是普通 ChatGPT 会话页。打开一个具体会话后可开始同步。",
      diagnostics: null,
    };
    renderRealtimeStatus(values);
    return;
  }
  const contentSnapshot = await getContentScriptSnapshot();
  values.contentScriptDetected = contentSnapshot.loaded;
  values.activeConversationId = conversationId;
  values.realtimeStatus = {
    ...(values.realtimeStatus || {}),
    activeConversationId:
      contentSnapshot.activeConversationId || values.realtimeStatus?.activeConversationId || "",
    timerRunning: contentSnapshot.timerRunning === true,
  };
  if (
    values.activeRealtimeSession?.enabled &&
    (!contentSnapshot.timerRunning ||
      values.activeRealtimeSession.conversationId !== conversationId ||
      (contentSnapshot.activeConversationId &&
        contentSnapshot.activeConversationId !== conversationId))
  ) {
    await sendMessage({ type: "stopRealtimeSync" });
    values.activeRealtimeSession = null;
    values.realtimeSyncEnabled = false;
    values.realtimeStatus = {
      ...(values.realtimeStatus || {}),
      state: "stopped_due_to_inconsistent_realtime_state",
      message: "实时同步状态不一致，已停止，请重新开始同步。",
      lastError: "实时同步状态不一致，已停止，请重新开始同步。",
      timerRunning: false,
      activeConversationId: "",
    };
  }
  renderRealtimeStatus(values);
}

function normalizeCooldownSeconds(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) {
    return DEFAULT_ADVANCED_COOLDOWN_SECONDS;
  }
  return Math.max(0, Math.min(60, Math.round(seconds)));
}

function normalizePopupSettings(values) {
  return {
    safeMode:
      typeof values.safeMode === "boolean" ? values.safeMode : DEFAULT_SAFE_MODE,
    advancedCooldownSeconds: normalizeCooldownSeconds(
      values.advancedCooldownSeconds ?? DEFAULT_ADVANCED_COOLDOWN_SECONDS
    ),
    advancedImportIntervalSeconds: normalizeBulkSeconds(
      values.advancedImportIntervalSeconds ?? DEFAULT_ADVANCED_IMPORT_INTERVAL_SECONDS
    ),
    advancedMaxBulkConversations: normalizeBulkMaxCount(
      values.advancedMaxBulkConversations ?? DEFAULT_ADVANCED_MAX_BULK_CONVERSATIONS
    ),
    advancedImportAll: Boolean(values.advancedImportAll),
    advancedBulkConfirmed: Boolean(values.advancedBulkConfirmed),
    realtimeSyncEnabled:
      typeof values.realtimeSyncEnabled === "boolean"
        ? values.realtimeSyncEnabled
        : DEFAULT_REALTIME_SYNC_ENABLED,
    realtimeSyncIntervalSeconds: normalizeRealtimeIntervalSeconds(
      values.realtimeSyncIntervalSeconds ?? DEFAULT_REALTIME_SYNC_INTERVAL_SECONDS
    )
  };
}

async function savePopupSettings(patch) {
  await chrome.storage.local.set({
    ...patch
  });
}

async function persistBulkSettings() {
  await savePopupSettings({
    advancedImportIntervalSeconds: normalizeBulkSeconds(bulkIntervalSecondsInput.value),
    advancedMaxBulkConversations: normalizeBulkMaxCount(bulkMaxCountInput.value),
    advancedImportAll: bulkUseAll.checked,
    advancedBulkConfirmed: bulkConfirmed.checked
  });
  updateBulkControls();
}

async function loadPopupSettings() {
  const values = await chrome.storage.local.get([
    "safeMode",
    "advancedCooldownSeconds",
    "advancedImportIntervalSeconds",
    "advancedMaxBulkConversations",
    "advancedImportAll",
    "advancedBulkConfirmed",
    "realtimeSyncEnabled",
    "realtimeSyncIntervalSeconds"
  ]);
  const settings = normalizePopupSettings(values);
  await savePopupSettings(settings);
  advancedCooldownInput.value = String(settings.advancedCooldownSeconds);
  bulkIntervalSecondsInput.value = String(settings.advancedImportIntervalSeconds);
  bulkMaxCountInput.value = String(settings.advancedMaxBulkConversations);
  bulkUseAll.checked = settings.advancedImportAll;
  bulkConfirmed.checked = settings.advancedBulkConfirmed;
  realtimeIntervalSecondsInput.value = String(settings.realtimeSyncIntervalSeconds);
  renderMode(settings.safeMode, settings.advancedCooldownSeconds);
  updateBulkControls();
  return settings;
}

function renderMode(safeMode, advancedCooldownSeconds) {
  advancedCooldownInput.value = String(normalizeCooldownSeconds(advancedCooldownSeconds));
  importButton.hidden = false;
  importButton.textContent = "开始同步当前会话";
  importModeHelp.textContent =
    "首次同步会先建立完整基线，可能需要几十秒；之后实时同步只增量更新当前会话文字。";
  advancedModeSettings.hidden = true;
  developerBulkSection.hidden = true;
  if (safeMode) {
    modeNotice.textContent = "安全模式已开启：仅显示当前会话导出，高级完整导出和批量导出入口默认隐藏。";
    modeNameEl.textContent = "安全模式";
    modeDescriptionEl.textContent = "安全模式会隐藏高级完整导出和批量导出入口，推荐普通用户保持开启。";
    modeToggle.textContent = "安全模式：开启";
    return;
  }

  modeNotice.textContent = "高级模式已开启：完整导出和开发者批量导出入口已显示，请合理设置访问频率。";
  modeNameEl.textContent = "高级模式";
  modeDescriptionEl.textContent = "高级模式会显示完整导出和开发者批量导出，并允许调整访问频率。";
  modeToggle.textContent = "高级模式：开启";
}

function formatList(value) {
  return Array.isArray(value) && value.length > 0 ? value.join(", ") : "无";
}

function renderDiagnostics(diagnostics) {
  if (!diagnostics) {
    historyDiagnosticsEl.hidden = true;
    return;
  }
  historyDiagnosticsEl.hidden = false;
  diagnosticsUrlEl.textContent = diagnostics.listFetchUrl || "无";
  diagnosticsStatusEl.textContent = String(diagnostics.httpStatus || "无");
  diagnosticsSizeEl.textContent = String(diagnostics.responseSize || 0);
  diagnosticsTopLevelKeysEl.textContent = formatList(diagnostics.topLevelKeys);
  diagnosticsCandidatePathsEl.textContent = formatList(diagnostics.candidatePaths);
  diagnosticsCandidateLengthsEl.textContent = JSON.stringify(diagnostics.candidateLengths || {});
  diagnosticsFirstItemKeysEl.textContent = formatList(diagnostics.firstItemKeys);
  diagnosticsPreviewEl.textContent = diagnostics.responsePreview || "无";
}

function normalizeBulkSeconds(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) {
    return 20;
  }
  return Math.max(0, Math.round(seconds));
}

function normalizeBulkMaxCount(value) {
  const count = Number(value);
  if (!Number.isFinite(count)) {
    return 20;
  }
  return Math.max(1, Math.round(count));
}

function updateBulkControls() {
  const intervalSeconds = normalizeBulkSeconds(bulkIntervalSecondsInput.value);
  bulkIntervalSecondsInput.value = String(intervalSeconds);
  bulkIntervalWarning.hidden = intervalSeconds !== 0;
  bulkMaxCountInput.disabled = bulkUseAll.checked;
  bulkScanButton.disabled = false;
  bulkSelectAllButton.disabled = scannedConversations.length === 0;
  bulkExportSelectedButton.disabled =
    !bulkConfirmed.checked || selectedConversationIds().length === 0;
}

function renderBulkStatus(status) {
  const total = status.total || 0;
  const index = status.index || 0;
  const title = status.currentTitle || "无";
  const waiting = status.waitingSeconds || 0;
  const recentError = status.recentError ? `\n最近错误：${status.recentError}` : "";
  bulkStopButton.disabled = !status.running;
  bulkProgressEl.textContent =
    `状态：${status.mode || "idle"}\n` +
    `当前：${index} / ${total}\n` +
    `会话：${title}\n` +
    `成功：${status.success || 0}，失败：${status.failed || 0}，跳过：${status.skipped || 0}\n` +
    `等待：${waiting} 秒` +
    recentError;
}

function taskStatusLabel(status) {
  if (status === "running") return "运行中";
  if (status === "success") return "成功";
  if (status === "failed") return "失败";
  if (status === "stopped") return "已停止";
  return "空闲";
}

function taskTypeLabel(type) {
  if (type === "import-current") return "正在导出当前会话";
  if (type === "sync-current") return "正在同步当前会话";
  if (type === "recalibrate-current") return "正在重新校准当前会话";
  if (type === "regenerate-notes") return "正在重新生成当前会话笔记";
  if (type === "history-scan") return "正在扫描历史会话列表";
  if (type === "bulk-import") return "正在批量导出";
  return "空闲";
}

function renderBaselineStatus(status) {
  if (!status || status.ok === false) {
    baselineStatusEl.textContent = "未检测";
    baselineMessageCountEl.textContent = "0";
    baselineFullAtEl.textContent = "无";
    baselineRealtimeAtEl.textContent = "无";
    syncSourceEl.textContent = "未检测";
    fullExportMessageCountEl.textContent = "0";
    mappingNodeCountEl.textContent = "0";
    candidateMessageNodeCountEl.textContent = "0";
    partCountEl.textContent = "0";
    exportedSectionCountEl.textContent = "0";
    orderIssueCountEl.textContent = "0";
    lastExportedTextPreviewEl.textContent = "无";
    parserWarningEl.textContent = "无";
    return;
  }
  if (!status.exists) {
    baselineStatusEl.textContent = "未建立完整基线";
    syncSourceEl.textContent = "无";
  } else if (status.full_snapshot_quality === "suspect") {
    baselineStatusEl.textContent = "完整基线疑似不完整";
    syncSourceEl.textContent = "full snapshot suspect";
  } else if (status.has_full_snapshot && status.needs_recalibration) {
    baselineStatusEl.textContent = `需要重新校准：${status.reason || "未知原因"}`;
    syncSourceEl.textContent = "full snapshot";
  } else if (status.has_full_snapshot) {
    baselineStatusEl.textContent = "已建立完整基线";
    syncSourceEl.textContent = "full snapshot";
  } else {
    baselineStatusEl.textContent = "当前仅保存了页面可见内容，尚未建立完整基线。";
    syncSourceEl.textContent = "realtime partial";
  }
  baselineMessageCountEl.textContent = String(status.message_count || 0);
  baselineFullAtEl.textContent = status.last_full_export_at || "无";
  baselineRealtimeAtEl.textContent = status.last_realtime_sync_at || "无";
  fullExportMessageCountEl.textContent = String(status.last_full_export_message_count || 0);
  mappingNodeCountEl.textContent = String(status.last_full_export_mapping_node_count || 0);
  candidateMessageNodeCountEl.textContent = String(
    status.last_full_export_candidate_message_count || 0
  );
  partCountEl.textContent = String(status.part_count || 0);
  exportedSectionCountEl.textContent = String(status.exported_section_count || 0);
  orderIssueCountEl.textContent = String(
    (status.order_gap_count || 0) +
      (status.duplicate_order_index_count || 0) +
      (status.missing_order_index_count || 0)
  );
  lastExportedTextPreviewEl.textContent = status.last_exported_text_preview || "无";
  parserWarningEl.textContent = status.last_full_export_warning || "无";
}

async function refreshBaselineStatus(conversationId) {
  if (!conversationId) {
    renderBaselineStatus(null);
    return;
  }
  try {
    const response = await sendMessage({
      type: "getConversationStatus",
      conversationId
    });
    if (!response.ok) {
      throw new Error(response.error);
    }
    renderBaselineStatus(response.data);
  } catch (_error) {
    baselineStatusEl.textContent = "状态获取失败";
    baselineMessageCountEl.textContent = "0";
    baselineFullAtEl.textContent = "无";
    baselineRealtimeAtEl.textContent = "无";
    partCountEl.textContent = "0";
    exportedSectionCountEl.textContent = "0";
    orderIssueCountEl.textContent = "0";
    lastExportedTextPreviewEl.textContent = "无";
  }
}

function renderTaskState(state) {
  const status = state.status || "idle";
  const type = state.type || "idle";
  taskStatusEl.textContent =
    status === "idle" ? "空闲" : `${taskTypeLabel(type)} / ${taskStatusLabel(status)}`;
  taskTitleEl.textContent = state.title || "无";
  taskProgressEl.textContent = `${state.current || 0} / ${state.total || 0}`;
  taskErrorEl.textContent = state.lastError || "无";
  taskSuggestionEl.textContent = state.suggestion || "无";
  renderDiagnostics(state.diagnostics);
  if (type === "bulk-import") {
    renderBulkStatus({
      mode: status,
      running: status === "running",
      index: state.current || 0,
      total: state.total || 0,
      currentTitle: state.title || "无",
      success: state.success || 0,
      failed: state.failed || 0,
      skipped: state.skipped || 0,
      waitingSeconds: state.waitingSeconds || 0,
      recentError: state.lastError || ""
    });
  }
}

function shortConversationId(conversationId) {
  const value = String(conversationId || "");
  return value.length > 10 ? `${value.slice(0, 8)}...${value.slice(-4)}` : value;
}

function selectedConversationIds() {
  return Array.from(bulkListEl.querySelectorAll("input[type='checkbox']:checked")).map(
    (input) => input.value
  );
}

function renderScannedConversations(conversations) {
  scannedConversations = Array.isArray(conversations) ? conversations : [];
  bulkListEl.textContent = "";
  if (scannedConversations.length === 0) {
    bulkListEl.textContent = "尚未扫描历史会话列表。";
    updateBulkControls();
    return;
  }

  for (const item of scannedConversations) {
    const row = document.createElement("label");
    row.className = "check-row";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = item.conversation_id || "";
    checkbox.addEventListener("change", updateBulkControls);

    const text = document.createElement("span");
    const updated = item.update_time || item.create_time || "";
    text.textContent = `${item.title || "Untitled Chat"} (${shortConversationId(item.conversation_id)})${updated ? ` · ${updated}` : ""}`;

    row.appendChild(checkbox);
    row.appendChild(text);
    bulkListEl.appendChild(row);
  }
  updateBulkControls();
}

async function refreshTaskState() {
  try {
    const response = await sendMessage({ type: "getTaskState" });
    if (!response.ok) {
      throw new Error(response.error);
    }
    renderTaskState(response.data);
  } catch (error) {
    taskErrorEl.textContent = String(error && error.message ? error.message : error);
  }
}

async function refreshBulkStatus() {
  try {
    const response = await sendMessage({ type: "getBulkStatus" });
    if (!response.ok) {
      throw new Error(response.error);
    }
    renderBulkStatus(response.data);
    if (response.data.running || response.data.mode === "stopping") {
      bulkPollTimer = setTimeout(refreshBulkStatus, 1000);
    }
  } catch (error) {
    bulkProgressEl.textContent = String(error && error.message ? error.message : error);
  }
}

function scheduleBulkStatusRefresh() {
  if (bulkPollTimer) {
    clearTimeout(bulkPollTimer);
  }
  bulkPollTimer = setTimeout(refreshBulkStatus, 300);
}

function renderStatus(status, options) {
  const preserveMessage = options && options.preserveMessage;
  const safeMode = status.safeMode !== false;
  const popupParsedConversationId = status.popupParsedConversationId || "";
  const contentReportedConversationId = status.contentReportedConversationId || "";
  const isConversationPage = Boolean(popupParsedConversationId);
  const activeSessionEnabled = Boolean(
    status.activeRealtimeSession && status.activeRealtimeSession.enabled
  );
  status.supported = Boolean(popupParsedConversationId);
  serviceEl.textContent = status.serviceConnected ? "已连接" : "未连接";
  conversationEl.textContent = popupParsedConversationId || "未识别";
  supportedEl.textContent = popupParsedConversationId ? "支持导出" : "不支持";
  activeTabUrlEl.textContent = shortenUrl(status.activeTabUrl || "");
  popupConversationEl.textContent = popupParsedConversationId || "未识别";
  contentConversationEl.textContent = contentReportedConversationId || "未检测到";
  conversationMismatchEl.textContent = CONVERSATION_MISMATCH_MESSAGE;
  conversationMismatchEl.hidden =
    !popupParsedConversationId ||
    !contentReportedConversationId ||
    popupParsedConversationId === contentReportedConversationId;
  baselineSection.hidden = !isConversationPage;
  taskSection.hidden = !isConversationPage;
  realtimeSection.hidden = !isConversationPage;
  advancedCurrentSection.hidden = !isConversationPage;
  developerBulkSection.hidden = !isConversationPage;
  importButton.hidden = !isConversationPage;
  stopRealtimeButton.hidden = !isConversationPage && !activeSessionEnabled;
  regenerateNotesButton.hidden = !isConversationPage;
  importModeHelp.hidden = !isConversationPage;
  importButton.disabled = !status.serviceConnected || !status.supported;
  regenerateNotesButton.disabled = !status.serviceConnected || !status.supported;
  recalibrateButton.disabled = !status.serviceConnected || !status.supported;
  renderMode(safeMode, status.advancedCooldownSeconds);

  if (preserveMessage) {
    return;
  }

  if (!status.serviceConnected) {
    setMessage("请先启动本地同步器，并打开 http://127.0.0.1:8765/ 完成设置。", "error");
  } else if (!popupParsedConversationId) {
    setMessage("当前不是普通 ChatGPT 会话页。打开一个具体会话后可开始同步。", "error");
  } else if (safeMode) {
    setMessage("安全模式已开启。点击“开始同步当前会话”会先确认完整基线，再开启实时文字同步。", "");
  } else {
    setMessage("准备就绪。主流程仍是同步当前会话；批量历史导出暂列为实验功能。", "");
  }
}

async function refreshStatus(options) {
  try {
    const response = await sendMessage({ type: "getStatus" });
    if (!response.ok) {
      throw new Error(response.error);
    }
    const { tab, conversationId: popupParsedConversationId } =
      await getActiveConversationSnapshot();
    const contentSnapshot = popupParsedConversationId
      ? await getContentScriptSnapshot()
      : { loaded: false, conversationId: "" };
    renderStatus(
      {
        ...response.data,
        activeTabUrl: tab?.url || "",
        popupParsedConversationId,
        contentReportedConversationId: contentSnapshot.conversationId || "",
        conversationId: popupParsedConversationId,
        supported: Boolean(popupParsedConversationId),
      },
      options
    );
    await refreshBaselineStatus(popupParsedConversationId);
  } catch (error) {
    serviceEl.textContent = "未知";
    conversationEl.textContent = "未知";
    supportedEl.textContent = "未知";
    importButton.disabled = true;
    importButton.hidden = true;
    if (!options || !options.preserveMessage) {
      setMessage(String(error && error.message ? error.message : error), "error");
    }
  }
}

importButton.addEventListener("click", async () => {
  importButton.disabled = true;
  setMessage("正在启动当前会话同步；如果本地没有完整基线，会先后台校准一次...", "");
  try {
    const response = await sendMessage({ type: "startSyncCurrentConversation" });
    if (!response.ok) {
      throw new Error(response.error);
    }
    const result = response.data;
    const baseline = result.baseline_status || {};
    if (result.mode === "baseline-created") {
      setMessage(
        `完整基线已建立，实时同步已开启。当前数据库消息数：${baseline.message_count || 0}`,
        "success"
      );
    } else if (baseline.full_snapshot_quality === "suspect") {
      setMessage("完整导出疑似不完整，请重新校准或查看诊断。", "error");
    } else if (result.mode === "realtime-started-recalibrating") {
      setMessage("实时同步已开启；完整基线较旧，正在后台重新校准。", "success");
    } else {
      setMessage("实时同步已开启。", "success");
    }
  } catch (error) {
    setMessage(String(error && error.message ? error.message : error), "error");
  } finally {
    await refreshStatus({ preserveMessage: true });
    await refreshTaskState();
  }
});

stopRealtimeButton.addEventListener("click", async () => {
  stopRealtimeButton.disabled = true;
  importButton.disabled = false;
  realtimeStateEl.textContent = "关闭";
  realtimeErrorEl.textContent = "实时同步已停止";
  setMessage("实时同步已停止。", "success");
  try {
    const response = await sendMessage({ type: "stopRealtimeSync" });
    if (!response.ok) {
      throw new Error(response.error);
    }
    await refreshRealtimeStatus();
    await refreshTaskState();
  } catch (error) {
    setMessage(String(error && error.message ? error.message : error), "error");
  }
});

recalibrateButton.addEventListener("click", async () => {
  recalibrateButton.disabled = true;
  setMessage("正在后台重新校准当前会话完整基线...", "");
  try {
    const response = await sendMessage({ type: "recalibrateCurrentConversation" });
    if (!response.ok) {
      throw new Error(response.error);
    }
    const baseline = response.data.baseline_status || {};
    setMessage(`重新校准完成。当前数据库消息数：${baseline.message_count || 0}`, "success");
  } catch (error) {
    setMessage(String(error && error.message ? error.message : error), "error");
  } finally {
    recalibrateButton.disabled = false;
    await refreshStatus({ preserveMessage: true });
    await refreshTaskState();
  }
});

regenerateNotesButton.addEventListener("click", async () => {
  regenerateNotesButton.disabled = true;
  setMessage("正在根据本地数据库重新生成当前会话笔记...", "");
  try {
    const response = await sendMessage({ type: "regenerateCurrentConversationNotes" });
    if (!response.ok) {
      throw new Error(response.error);
    }
    const result = response.data || {};
    if (result.exported) {
      const files = (result.updated_files || []).join("、") || "无变化";
      setMessage(`当前会话笔记已重新生成。更新文件：${files}`, "success");
    } else {
      setMessage(`数据库已有消息，但 Markdown 导出失败：${result.export_error || "未知错误"}`, "error");
    }
  } catch (error) {
    setMessage(String(error && error.message ? error.message : error), "error");
  } finally {
    regenerateNotesButton.disabled = false;
    await refreshStatus({ preserveMessage: true });
    await refreshTaskState();
  }
});

modeToggle.addEventListener("click", async () => {
  modeToggle.disabled = true;
  try {
    const nextSafeMode = modeNameEl.textContent !== "安全模式";
    const response = await sendMessage({ type: "setSafeMode", safeMode: nextSafeMode });
    if (!response.ok) {
      throw new Error(response.error);
    }
    renderMode(response.data.safeMode !== false, advancedCooldownInput.value);
    setMessage(
      response.data.safeMode
        ? "已切换到安全模式。当前会话导出可用，批量导出入口已隐藏。"
        : "已切换到高级模式。完整导出和批量导出入口已显示。",
      "success"
    );
  } catch (error) {
    setMessage(String(error && error.message ? error.message : error), "error");
  } finally {
    modeToggle.disabled = false;
    await refreshStatus({ preserveMessage: true });
  }
});

bulkIntervalSecondsInput.addEventListener("change", persistBulkSettings);
bulkMaxCountInput.addEventListener("change", persistBulkSettings);
bulkUseAll.addEventListener("change", persistBulkSettings);
bulkConfirmed.addEventListener("change", persistBulkSettings);

bulkScanButton.addEventListener("click", async () => {
  updateBulkControls();
  const options = {
    bulkIntervalSeconds: normalizeBulkSeconds(bulkIntervalSecondsInput.value),
    bulkMaxCount: normalizeBulkMaxCount(bulkMaxCountInput.value),
    bulkUseAll: bulkUseAll.checked
  };
  await savePopupSettings({
    advancedImportIntervalSeconds: options.bulkIntervalSeconds,
    advancedMaxBulkConversations: options.bulkMaxCount,
    advancedImportAll: options.bulkUseAll,
    advancedBulkConfirmed: bulkConfirmed.checked
  });

  try {
    const response = await sendMessage({ type: "scanHistoryConversations", options });
    if (!response.ok) {
      throw new Error(response.error);
    }
    renderScannedConversations(response.data.conversations || []);
    await refreshTaskState();
    setMessage(`扫描完成：找到 ${(response.data.conversations || []).length} 个会话。请选择要导出的会话。`, "success");
  } catch (error) {
    await refreshTaskState();
    setMessage(`扫描历史会话列表失败：${String(error && error.message ? error.message : error)}`, "error");
  }
});

bulkSelectAllButton.addEventListener("click", () => {
  for (const checkbox of bulkListEl.querySelectorAll("input[type='checkbox']")) {
    checkbox.checked = true;
  }
  updateBulkControls();
});

bulkExportSelectedButton.addEventListener("click", async () => {
  updateBulkControls();
  if (!bulkConfirmed.checked) {
    setMessage("请先勾选批量导出确认。", "error");
    return;
  }
  const selectedIds = selectedConversationIds();
  if (selectedIds.length === 0) {
    setMessage("请先选择至少一个会话。", "error");
    return;
  }
  if (
    !confirm(
      "批量导出会连续访问多个 ChatGPT 会话。请确认你只用于备份自己账号下可访问的会话。建议设置合理间隔。是否继续？"
    )
  ) {
    return;
  }

  const options = {
    bulkIntervalSeconds: normalizeBulkSeconds(bulkIntervalSecondsInput.value),
    bulkMaxCount: normalizeBulkMaxCount(bulkMaxCountInput.value),
    bulkUseAll: false,
    selectedConversationIds: selectedIds
  };

  try {
    const response = await sendMessage({ type: "startSelectedBulkImport", options });
    if (!response.ok) {
      throw new Error(response.error);
    }
    renderBulkStatus(response.data);
    await refreshTaskState();
    setMessage("批量导出已启动。", "success");
    scheduleBulkStatusRefresh();
  } catch (error) {
    await refreshTaskState();
    setMessage(`批量导出启动失败：${String(error && error.message ? error.message : error)}`, "error");
  }
});

bulkStopButton.addEventListener("click", async () => {
  try {
    const response = await sendMessage({ type: "stopBulkImport" });
    if (!response.ok) {
      throw new Error(response.error);
    }
    renderBulkStatus(response.data);
    await refreshTaskState();
    setMessage("已请求停止批量导出。", "success");
    scheduleBulkStatusRefresh();
  } catch (error) {
    setMessage(String(error && error.message ? error.message : error), "error");
  }
});

advancedCooldownInput.addEventListener("change", async () => {
  const advancedCooldownSeconds = normalizeCooldownSeconds(advancedCooldownInput.value);
  advancedCooldownInput.value = String(advancedCooldownSeconds);
  try {
    const response = await sendMessage({
      type: "setAdvancedCooldownSeconds",
      advancedCooldownSeconds
    });
    if (!response.ok) {
      throw new Error(response.error);
    }
    advancedCooldownInput.value = String(response.data.advancedCooldownSeconds);
    await savePopupSettings({ advancedCooldownSeconds: response.data.advancedCooldownSeconds });
    setMessage(
      response.data.advancedCooldownSeconds === 0
        ? "高级模式冷却已设为 0 秒。批量导出时不会额外等待。"
        : `高级模式冷却已设为 ${response.data.advancedCooldownSeconds} 秒。`,
      "success"
    );
  } catch (error) {
    setMessage(String(error && error.message ? error.message : error), "error");
  }
});

realtimeToggle.addEventListener("click", async () => {
  const { conversationId } = await getActiveConversationSnapshot();
  if (!conversationId) {
    setMessage("当前不是普通 ChatGPT 会话页。打开一个具体会话后可开始同步。", "error");
    await refreshRealtimeStatus();
    return;
  }
  const values = await chrome.storage.local.get(["realtimeSyncEnabled"]);
  const nextEnabled = !(values.realtimeSyncEnabled === true);
  const intervalSeconds = normalizeRealtimeIntervalSeconds(realtimeIntervalSecondsInput.value);
  await chrome.storage.local.set({
    realtimeSyncEnabled: nextEnabled,
    realtimeSyncIntervalSeconds: intervalSeconds,
  });
  await sendRealtimeMessageToActiveTab({
    type: "REALTIME_SYNC_TOGGLE",
    enabled: nextEnabled,
  });
  await refreshRealtimeStatus();
  setMessage(nextEnabled ? "实时同步已开启。" : "实时同步已关闭。", "success");
});

realtimeIntervalSecondsInput.addEventListener("change", async () => {
  const intervalSeconds = normalizeRealtimeIntervalSeconds(realtimeIntervalSecondsInput.value);
  realtimeIntervalSecondsInput.value = String(intervalSeconds);
  await chrome.storage.local.set({
    realtimeSyncIntervalSeconds: intervalSeconds,
  });
  await refreshRealtimeStatus();
  setMessage(`实时同步间隔已设为 ${intervalSeconds} 秒。`, "success");
});

document.addEventListener("DOMContentLoaded", async () => {
  await loadPopupSettings();
  await refreshStatus();
  await refreshTaskState();
  await refreshBulkStatus();
  await refreshRealtimeStatus();
  taskPollTimer = setInterval(refreshTaskState, 1000);
  realtimePollTimer = setInterval(refreshRealtimeStatus, 1000);
});
