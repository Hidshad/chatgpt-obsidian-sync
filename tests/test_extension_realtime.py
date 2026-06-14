import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
EXTENSION = ROOT / "browser-extension"


def read_text(relative_path: str) -> str:
    return (ROOT / relative_path).read_text(encoding="utf-8")


def test_manifest_registers_content_script_for_chatgpt_pages():
    manifest = json.loads((EXTENSION / "manifest.json").read_text(encoding="utf-8"))

    assert "scripting" in manifest["permissions"]
    content_scripts = manifest["content_scripts"]
    assert content_scripts[0]["matches"] == [
        "https://chatgpt.com/*",
        "https://chat.openai.com/*",
    ]
    assert content_scripts[0]["js"] == ["conversation-url.js", "content.js"]
    assert content_scripts[0]["run_at"] == "document_idle"


def test_background_ensures_content_script_before_starting_realtime():
    background = read_text("browser-extension/background.js")

    assert "async function ensureContentScript(tab)" in background
    assert 'type: "CHATGPT_OBSIDIAN_PING"' in background
    assert "chrome.scripting.executeScript" in background
    assert 'executeContentScriptFile(tabId, "conversation-url.js")' in background
    assert 'executeContentScriptFile(tabId, "content.js")' in background
    assert background.index('executeContentScriptFile(tabId, "conversation-url.js")') < background.index(
        'executeContentScriptFile(tabId, "content.js")'
    )
    assert 'stage: "ping-ok"' in background
    assert 'stage: "injecting"' in background
    assert 'stage: "inject-ok"' in background
    assert 'stage: "inject-failed"' in background
    assert 'stage: "ping-after-inject-failed"' in background
    assert "注入执行成功，但 content script 未响应。" in background
    assert "content script 注入失败，请刷新 ChatGPT 页面后重试。" in background
    assert background.index("await ensureContentScript(tab)") < background.index(
        "const ack = await notifyRealtimeSessionTab(session, true)"
    )


def test_content_script_has_ping_handler_and_duplicate_injection_guard():
    content = read_text("browser-extension/content.js")

    assert "__CHATGPT_OBSIDIAN_SYNC_CONTENT_LOADED" in content
    assert "__CHATGPT_OBSIDIAN_SYNC_LISTENER_REGISTERED" in content
    assert "function registerContentMessageListener" in content
    assert "registerContentMessageListener();" in content
    assert 'message.type === "CHATGPT_OBSIDIAN_PING"' in content
    assert "contentScriptLoaded: true" in content
    assert "realtimeEnabled" in content
    assert "timerRunning: isRealtimeTimerRunning()" in content
    assert "startRealtimeTimer(runImmediately)" in content
    assert "clearRealtimeTimer();" in content


def test_popup_content_script_loaded_comes_from_current_tab_ping():
    popup_js = read_text("browser-extension/popup.js")

    assert 'type: "CHATGPT_OBSIDIAN_PING"' in popup_js
    assert "const contentScriptLoaded = values.contentScriptDetected === true" in popup_js
    assert "realtimeStatus.contentScriptLoaded" not in popup_js.split(
        "function renderRealtimeStatus", 1
    )[1].split("function normalizeCooldownSeconds", 1)[0]


def test_content_script_exists_and_syncs_visible_text_only():
    content = read_text("browser-extension/content.js")

    assert "ChatGptObsidianUrl.parseConversationIdFromUrl" in content
    assert "const DEFAULT_REALTIME_SYNC_ENABLED = false" in content
    assert "const DEFAULT_REALTIME_SYNC_INTERVAL_SECONDS = 30" in content
    assert "const MIN_REALTIME_SYNC_INTERVAL_SECONDS = 10" in content
    assert "const MAX_REALTIME_SYNC_INTERVAL_SECONDS = 300" in content
    assert "document.querySelectorAll(\"[data-message-author-role]\")" in content
    assert "POST" in content
    assert "/api/messages" in content
    assert "/api/assets" not in content
    assert "collectImageAsset" not in content
    assert "shouldCollectImage" not in content
    assert "chrome.tabs" not in content
    assert "chrome.debugger" not in content
    assert "source: \"extension-content-realtime\"" in content
    assert "function collectMessageNodes" in content
    assert "function extractMessageText" in content


def test_content_script_resets_state_and_discards_pending_work_on_route_change():
    content = read_text("browser-extension/content.js")

    assert "let lastConversationId = \"\"" in content
    assert "let pendingPayload = null" in content
    assert "const seenMessageIdsByConversation = new Map()" in content
    assert "function resetConversationState" in content
    assert "seenMessageIdsByConversation.set(conversationId, new Set())" in content
    assert "pendingPayload = null" in content
    assert "lastSyncAt = \"\"" in content
    assert "lastPayloadJson = \"\"" in content
    assert "const syncConversationId = parseConversationIdFromUrl(window.location.href)" in content
    assert "syncConversationId !== getCurrentConversationId()" in content
    assert "payload.conversation_id !== getCurrentConversationId()" in content
    assert "return { status: \"stale\" }" in content
    assert "function stopRealtimeDueToConversationChange" in content
    assert "stopped_due_to_conversation_changed" in content
    assert "activeRealtimeSession" in content


def test_content_script_reports_loaded_and_explicit_skip_statuses():
    content = read_text("browser-extension/content.js")

    assert 'console.info("[ChatGPT Obsidian Sync] content script loaded")' in content
    assert "writeNonConversationStandbyStatus" in content
    assert "pageType: \"non_conversation\"" in content
    assert "当前不是普通 ChatGPT 会话页，扩展已静默待机" in content
    assert "contentScriptLoaded: true" in content
    assert "contentScriptLoadedAt" in content
    assert "跳过：当前页面不是普通 ChatGPT 会话页" in content
    assert "跳过：当前页面未识别 conversation_id" in content
    assert "跳过：当前扫描未检测到消息节点；未发送请求" in content
    assert "function getMessageScanDiagnostics" in content
    assert "\"[data-message-author-role]\"" in content
    assert "\"[data-testid^=\\\"conversation-turn\\\"]\"" in content
    assert "\"[data-testid*=\\\"conversation-turn\\\"]\"" in content
    assert "\"article\"" in content
    assert "\"main article\"" in content
    assert "bodyTextLength" in content
    assert "hasMain" in content
    assert "hasTextareaOrContenteditable" in content


def test_content_script_standby_on_non_conversation_pages_before_heavy_logic():
    content = read_text("browser-extension/content.js")

    assert "const initialConversationId = parseConversationIdFromUrl(window.location.href)" in content
    assert "function initializeConversationContentScript" in content
    assert "if (!initialConversationId)" in content
    assert "writeNonConversationStandbyStatus();" in content
    assert "initializeConversationContentScript();" in content

    standby_block = content.split("if (!initialConversationId)", 1)[1].split("} else", 1)[0]
    assert "querySelectorAll" not in standby_block
    assert "MutationObserver" not in standby_block
    assert "fetch(" not in standby_block
    assert "MESSAGES_URL" not in standby_block

    init_block = content.split("function initializeConversationContentScript", 1)[1]
    assert "chrome.storage.onChanged.addListener" in init_block
    assert "new MutationObserver" in init_block
    assert "loadRealtimeSettings();" in init_block


def test_content_script_toggle_runs_immediately_and_interval_is_configurable():
    content = read_text("browser-extension/content.js")

    assert "REALTIME_SYNC_TOGGLE" in content
    assert "runRealtimeSyncOnce()" in content
    assert "startRealtimeTimer(true)" in content
    assert "realtimeSyncIntervalSeconds" in content
    assert "normalizeRealtimeIntervalSeconds" in content
    assert "changes.realtimeSyncIntervalSeconds" in content
    assert "restartRealtimeTimer()" in content
    assert "clearRealtimeTimer()" in content
    assert "function stopRealtimeSyncLocally" in content
    assert "function writeStoppedStatus" in content
    assert "state: \"stopped\"" in content
    assert "message: \"实时同步已停止\"" in content


def test_content_script_reports_api_failure_to_popup():
    content = read_text("browser-extension/content.js")

    assert "同步失败：无法连接本地服务 127.0.0.1:8765" in content
    assert "同步失败：HTTP ${response.status}" in content
    assert "lastWriteResult" in content
    assert "result.inserted_messages" in content
    assert "result.updated_messages" in content
    assert "result.message_count_after" in content
    assert "result.output_folder" in content
    assert "result.updated_files" in content
    assert "result.export_error" in content


def test_content_script_reports_extracted_tail_diagnostics_to_popup():
    content = read_text("browser-extension/content.js")
    popup_js = read_text("browser-extension/popup.js")

    assert "function buildExtractedMessageDiagnostics" in content
    assert "extracted_message_count" in content
    assert "extracted_user_count" in content
    assert "extracted_assistant_count" in content
    assert "last_extracted_text_preview" in content
    assert "last_extracted_message_id" in content
    assert "last_extracted_is_fallback" in content
    assert "payload_message_ids_tail" in content
    assert "payload_text_previews_tail" in content
    assert "payload_message_ids_tail" in popup_js
    assert "payload_text_previews_tail" in popup_js


def test_content_script_preserves_last_successful_export_across_no_change_syncs():
    content = read_text("browser-extension/content.js")
    popup_js = read_text("browser-extension/popup.js")

    assert "lastSuccessfulExport" in content
    assert "result.exported === true" in content
    assert "last_successful_export_at" in content
    assert "status.lastSuccessfulExport ?? previousStatus.lastSuccessfulExport" in content
    assert "本轮无变化，未重新导出" in popup_js
    assert "最近一次成功导出" in popup_js
    assert "最近成功导出文件" in popup_js
    assert "最后导出消息" in popup_js
    assert "insertedTail" in content
    assert "本轮新增" in popup_js


def test_content_script_asserts_payload_conversation_id_before_post():
    content = read_text("browser-extension/content.js")

    assert "function assertPayloadConversationConsistency" in content
    assert "function validateRealtimePayload" in content
    assert "missing conversation_id" in content
    assert "messages must be an array" in content
    assert "missing message_id" in content
    assert "missing role" in content
    assert "local conversation_id mismatch before POST" in content
    assert "function formatRealtimeValidationError" in content
    assert "本地拦截：conversation_id mismatch before POST" in content
    assert "assertPayloadConversationConsistency(payload, {" in content
    assert "await postJson(MESSAGES_URL, payload)" in content
    assert content.index("assertPayloadConversationConsistency(payload, {") < content.index(
        "await postJson(MESSAGES_URL, payload)"
    )
    assert "return { status: \"invalid\", error: lastError }" in content
    assert "conversation_id: conversationId" in content


def test_content_script_builds_realtime_payload_from_current_conversation_id():
    content = read_text("browser-extension/content.js")

    assert "function buildRealtimePayload({ conversationId, title, messages })" in content
    assert "conversation_id: conversationId" in content
    assert "source: \"extension-content-realtime\"" in content
    assert "is_partial_snapshot: true" in content
    assert "conversation_id: conversationId," in content
    assert "const syncConversationId = parseConversationIdFromUrl(window.location.href)" in content
    assert "title: titleFromPage()" in content


def test_content_script_reports_server_mismatch_payload_diagnostics():
    content = read_text("browser-extension/content.js")

    assert "function formatServerErrorDetails" in content
    assert '"message_id"' in content
    assert '"existing_conversation_id"' in content
    assert '"payload_conversation_id"' in content
    assert '"message_conversation_ids"' in content
    assert '"mismatch_count"' in content
    assert "function payloadConversationDiagnostics" in content
    assert "payloadConversationId" in content
    assert "messageConversationIds" in content
    assert "messageCount" in content
    assert "firstMessageIds" in content
    assert "currentUrl: window.location.href" in content
    assert "currentConversationId: getCurrentConversationId()" in content
    assert "String(summary).includes(\"conversation_id mismatch\")" in content


def test_content_script_uses_stable_message_contract_and_ids():
    content = read_text("browser-extension/content.js")

    assert "function explicitMessageIdFrom" in content
    assert "async function sha256Hex" in content
    assert 'crypto.subtle.digest("SHA-256"' in content
    assert "data-message-id" in content
    assert "message_id: messageId" in content
    assert "text: content" in content
    assert "order_index: position" in content
    assert "`realtime:${conversationId}:${role}:${position}:${contentHash.slice(0, 16)}`" in content
    assert "page-" not in content
    explicit_block = content.split("function explicitMessageIdFrom", 1)[1].split(
        "async function messageIdFor", 1
    )[0]
    assert 'closest("[id]")' not in explicit_block
    assert "SUPPORTED_ROLES" in content
    assert "continue;" in content


def test_content_script_stops_realtime_after_message_owner_conflict():
    content = read_text("browser-extension/content.js")

    assert "function stopRealtimeDueToRejectedPayload" in content
    assert "sync_stopped_due_to_rejected_payload" in content
    assert "message_id already belongs to another conversation" in content
    assert "实时同步已停止：消息归属冲突。请重新完整校准或清理旧数据。" in content
    assert "serverError" in content


def test_content_script_requires_active_session_before_realtime_post():
    content = read_text("browser-extension/content.js")

    assert "function isRealtimeSessionCurrent" in content
    assert "activeRealtimeSession.conversationId === conversationId" in content
    assert "if (!manual && !isRealtimeSessionCurrent(syncConversationId))" in content
    post_index = content.index("await postJson(MESSAGES_URL, payload)")
    session_check_index = content.index("if (!manual && !isRealtimeSessionCurrent(syncConversationId))")
    assert session_check_index < post_index
    assert "activeRealtimeSession = message.session || null" in content
    assert "session: activeRealtimeSession" in content
    assert content.index("if (changes.activeRealtimeSession)") < content.index(
        "if (changes.realtimeSyncEnabled && !changes.activeRealtimeSession)"
    )


def test_collect_message_nodes_supports_chatgpt_fallback_selectors():
    content = read_text("browser-extension/content.js")

    assert 'collectCandidates("[data-message-author-role]")' in content
    assert 'collectCandidates("[data-testid^=\\"conversation-turn\\"]")' in content
    assert 'collectCandidates("[data-testid*=\\"conversation-turn\\"]")' in content
    assert 'collectCandidates("main article")' in content
    assert 'collectCandidates("article")' in content
    assert "inferRoleFromNode" in content
    assert "fallback by visible turn order" in content
    assert "isInsidePageChrome" in content


def test_extract_message_text_removes_common_action_labels():
    content = read_text("browser-extension/content.js")

    assert "function extractMessageText" in content
    assert "clone.querySelectorAll" in content
    assert '"Copy"' in content
    assert '"Edit"' in content
    assert '"Share"' in content
    assert '"重新生成"' in content
    assert "ACTION_LABELS" in content


def test_popup_can_toggle_realtime_sync_and_show_status():
    popup = read_text("browser-extension/popup.html")
    popup_js = read_text("browser-extension/popup.js")

    assert "实时同步：" in popup
    assert 'id="realtime-toggle"' in popup
    assert "最近同步时间" in popup
    assert "最近同步消息数" in popup
    assert "当前同步会话 ID" in popup
    assert "当前标签 URL" in popup
    assert "popup 解析会话 ID" in popup
    assert "content 报告会话 ID" in popup
    assert "content script" in popup
    assert "selector counts" in popup_js
    assert "同步间隔秒数" in popup
    assert "建议 30 秒以上" in popup
    assert "最近同步图片数" not in popup
    assert "最近错误" in popup
    assert "最近收到/新增/更新/跳过" in popup
    assert "数据库消息总数" in popup
    assert "Markdown 导出" in popup
    assert "输出文件夹" in popup
    assert "最近更新文件" in popup
    assert "导出错误" in popup
    assert "重新生成当前会话笔记" in popup
    assert "realtimeSyncEnabled" in popup_js
    assert "realtimeSyncIntervalSeconds" in popup_js
    assert "realtimeStatus" in popup_js
    assert "DEFAULT_REALTIME_SYNC_ENABLED = false" in popup_js
    assert "DEFAULT_REALTIME_SYNC_INTERVAL_SECONDS = 30" in popup_js
    assert "MIN_REALTIME_SYNC_INTERVAL_SECONDS = 10" in popup_js
    assert "MAX_REALTIME_SYNC_INTERVAL_SECONDS = 300" in popup_js
    assert "function normalizeRealtimeIntervalSeconds" in popup_js
    assert "chrome.storage.local.set" in popup_js
    assert "REALTIME_SYNC_TOGGLE" in popup_js
    assert "chrome.tabs.sendMessage" in popup_js
    assert "stopRealtimeButton.disabled = !activeSessionEnabled" in popup_js
    assert "realtimeToggle.disabled = nonConversationPage" in popup_js
    assert "const activeSessionEnabled = Boolean(activeRealtimeSession && activeRealtimeSession.enabled)" in popup_js
    assert "realtimeErrorEl.textContent = \"实时同步已停止\"" in popup_js
    assert "importButton.disabled = false" in popup_js
    assert "parseConversationIdFromUrl(tab.url || \"\")" in popup_js
    assert "当前标签页 URL 解析结果与 content script 报告不一致" in popup_js
    assert "lastWriteResult" in popup_js
    assert "数据库已更新，但 Markdown 导出失败" in popup_js
    assert "regenerateCurrentConversationNotes" in popup_js
    assert "shouldHideStaleRealtimeResult" in popup_js
    assert "上次实时同步来自其他会话，已隐藏。" in popup_js


def test_popup_is_quiet_on_non_conversation_active_tab():
    popup_js = read_text("browser-extension/popup.js")

    assert "当前不是普通 ChatGPT 会话页。打开一个具体会话后可开始同步。" in popup_js
    assert "pageType: \"non_conversation\"" in popup_js
    assert "if (!conversationId) {" in popup_js
    assert "return { loaded: false, conversationId: \"\", pageType: \"non_conversation\" };" in popup_js
    assert "不向非会话页发送实时同步消息" in popup_js
    assert "refreshRealtimeStatus" in popup_js
    assert "baselineSection.hidden = !isConversationPage" in popup_js
    assert "realtimeSection.hidden = !isConversationPage" in popup_js
    assert "taskSection.hidden = !isConversationPage" in popup_js
    assert "importButton.hidden = !isConversationPage" in popup_js
    assert "stopRealtimeButton.hidden = !isConversationPage" in popup_js
    assert "stopRealtimeButton.hidden = !isConversationPage && !activeSessionEnabled" in popup_js
    assert "reconcileRealtimeSession" in popup_js
    assert "检测到旧实时同步状态，已清理" in popup_js


def test_background_stop_realtime_persists_stopped_status():
    background = read_text("browser-extension/background.js")

    assert "async function stopRealtimeSync" in background
    assert "activeRealtimeSession" in background
    assert "realtimeStatus: {" in background
    assert "clearActiveRealtimeSession(\"stopped\")" in background
    assert "\"实时同步已停止\"" in background
    assert "await clearActiveRealtimeSession" in background
    assert "notifyRealtimeSessionTab" in background


def test_background_stores_active_realtime_session_with_tab_and_conversation():
    background = read_text("browser-extension/background.js")

    assert "function createActiveRealtimeSession(tab, conversationId)" in background
    assert "tabId: tab.id" in background
    assert "conversationId" in background
    assert "startedAt: new Date().toISOString()" in background
    assert "activeRealtimeSession: session" in background
    assert "chrome.tabs.onUpdated.addListener" in background
    assert "chrome.tabs.onRemoved.addListener" in background
    assert "stopRealtimeSessionBecause" in background


def test_realtime_start_requires_content_timer_ack():
    background = read_text("browser-extension/background.js")
    content = read_text("browser-extension/content.js")

    assert "async function startRealtimeSessionForTab" in background
    assert "activeRealtimeSession: session" in background
    assert "const ack = await notifyRealtimeSessionTab(session, true)" in background
    assert "ack.timerRunning !== true" in background
    assert "content timer did not start" in background
    assert "timerRunning: isRealtimeTimerRunning()" in content
    assert "activeConversationId: activeRealtimeSession.conversationId" in content
    toggle_block = content.split('message.type === "REALTIME_SYNC_TOGGLE"', 1)[1].split(
        'if (message.type !== "exportVisibleConversation")', 1
    )[0]
    assert 'message.type === "START_REALTIME_SYNC"' in content
    assert 'message.type === "STOP_REALTIME_SYNC"' in content
    assert "await updateRealtimeStatus" in toggle_block
    assert "return true;" in toggle_block


def test_reconcile_keeps_valid_session_and_clears_mismatched_tab_or_conversation():
    background = read_text("browser-extension/background.js")

    assert "activeTabId" in background
    assert "session.tabId !== tab.id" in background
    assert "reason: \"tab_mismatch\"" in background
    assert "activeConversationId !== session.conversationId" in background
    assert "reason: \"conversation_mismatch\"" in background
    assert "return { cleared: false, activeRealtimeSession: session }" in background


def test_popup_realtime_enabled_requires_storage_session_and_content_timer():
    popup_js = read_text("browser-extension/popup.js")

    assert "const contentTimerRunning = realtimeStatus.timerRunning === true" in popup_js
    assert "const realtimeStateConsistent =" in popup_js
    assert "activeSessionEnabled" in popup_js
    assert "contentTimerRunning" in popup_js
    assert "实时同步状态不一致，已停止，请重新开始同步。" in popup_js
    assert "stopRealtimeButton.disabled = !activeSessionEnabled" in popup_js


def test_background_regenerates_notes_from_local_database_only():
    background = read_text("browser-extension/background.js")
    regenerate_block = background[
        background.index("async function regenerateCurrentConversationNotes")
        : background.index("async function startSyncCurrentConversation")
    ]

    assert "regenerateConversationNotes(conversationId)" in regenerate_block
    assert "/api/conversation/export" in background
    assert "captureConversationResponseInBackgroundTab" not in regenerate_block
    assert "runFullCalibrationForTab" not in regenerate_block
    assert "chrome.debugger" not in regenerate_block


def test_popup_loads_shared_conversation_url_parser():
    popup = read_text("browser-extension/popup.html")

    assert '<script src="conversation-url.js"></script>' in popup
    assert popup.index('src="conversation-url.js"') < popup.index('src="popup.js"')


def test_background_uses_shared_conversation_url_parser():
    background = read_text("browser-extension/background.js")

    assert 'importScripts("conversation-url.js", "conversation-list-parser.js")' in background
    assert "ChatGptObsidianUrl.parseConversationIdFromUrl(pageUrl)" in background


def test_popup_displays_realtime_selector_diagnostics():
    popup_js = read_text("browser-extension/popup.js")

    assert "function formatRealtimeDiagnostics" in popup_js
    assert "selectorCounts" in popup_js
    assert "role=" in popup_js
    assert "turn=" in popup_js
    assert "article=" in popup_js
    assert "mainArticle=" in popup_js
    assert "bodyText=" in popup_js


def test_popup_interval_setting_is_not_hidden_in_safe_or_advanced_mode():
    popup = read_text("browser-extension/popup.html")
    popup_js = read_text("browser-extension/popup.js")

    assert 'id="realtime-interval-seconds"' in popup
    realtime_section = popup.split('<section class="mode-panel" id="realtime-section">')[-1].split(
        '<section class="bulk-section"', 1
    )[0]
    assert "advanced-settings" not in realtime_section
    assert "developer-bulk-section" not in realtime_section
    assert "realtimeIntervalSecondsInput.addEventListener" in popup_js
    assert "Math.max(MIN_REALTIME_SYNC_INTERVAL_SECONDS" in popup_js


def test_safe_export_reuses_content_script_without_background_tab():
    background = read_text("browser-extension/background.js")

    assert 'chrome.tabs.sendMessage(tab.id, { type: "exportVisibleConversation" })' in background
    assert "async function exportCurrentConversationSafe" in background
    safe_function = background.split("async function exportCurrentConversationSafe", 1)[1].split(
        "async function importCurrentConversation", 1
    )[0]
    assert "chrome.tabs.create" not in safe_function
    assert "chrome.debugger.attach" not in safe_function


def test_bulk_export_is_marked_experimental_in_popup():
    popup = read_text("browser-extension/popup.html")

    assert "实验功能，暂不推荐使用" in popup


def test_readme_documents_text_only_realtime_and_images_later():
    readme = read_text("README.md")

    assert "实时同步只同步文字" in readme
    assert "图片/附件同步仍在开发中" in readme
