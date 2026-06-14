import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
EXTENSION = ROOT / "browser-extension"


def read_text(relative_path: str) -> str:
    return (ROOT / relative_path).read_text(encoding="utf-8")


def test_extension_manifest_has_storage_for_safe_mode_cooldown():
    manifest = json.loads((EXTENSION / "manifest.json").read_text(encoding="utf-8"))

    assert "storage" in manifest["permissions"]


def test_background_defines_safe_mode_limits_and_messages():
    background = read_text("browser-extension/background.js")

    assert "DEFAULT_SAFE_MODE = true" in background
    assert "IMPORT_COOLDOWN_MS = 20000" in background
    assert "DEFAULT_ADVANCED_COOLDOWN_SECONDS = 20" in background
    assert "advancedCooldownSeconds" in background
    assert "CAPTURE_TIMEOUT_MS = 30000" in background
    assert "lastImportAt" in background
    assert "getSafeMode" in background
    assert "setSafeMode" in background
    assert "请先切换到高级模式，再扫描历史会话列表。" in background
    assert "getAdvancedCooldownSeconds" in background
    assert "setAdvancedCooldownSeconds" in background
    assert "为避免过于频繁访问，请等待" in background
    assert "未捕获到会话数据。请确认当前页面是普通 ChatGPT 会话页，稍后手动重试。" in background
    assert "refreshTriggered" not in background
    assert "chrome.tabs.reload" not in background


def test_background_advanced_mode_only_relaxes_cooldown():
    background = read_text("browser-extension/background.js")

    assert "const cooldownMs = safeMode ? IMPORT_COOLDOWN_MS : advancedCooldownSeconds * 1000" in background
    assert "advancedCooldownSeconds = await getAdvancedCooldownSeconds()" in background
    assert "Math.max(0, Math.min(60, seconds))" in background
    assert "captureConversationResponseInBackgroundTab(tab.url || \"\", conversationId)" in background
    assert "CAPTURE_TIMEOUT_MS = 30000" in background
    assert "refreshTriggered" not in background
    assert "setInterval" not in background


def test_background_supports_developer_bulk_export_with_scan_select_and_stop():
    background = read_text("browser-extension/background.js")

    assert "scanHistoryConversations" in background
    assert "startSelectedBulkImport" in background
    assert "stopBulkImport" in background
    assert "getBulkStatus" in background
    assert "captureConversationList" in background
    assert "/backend-api/conversations" in background
    assert "extractConversationList" in background
    assert "bulkState.stopRequested" in background
    assert "bulkState.mode = \"stopped\"" in background
    assert "bulkState.mode = \"running\"" in background
    assert "bulkIntervalSeconds" in background
    assert "bulkMaxCount" in background
    assert "bulkUseAll" in background
    assert "selectedConversations" in background


def test_background_blocks_debugger_flows_on_non_conversation_pages():
    background = read_text("browser-extension/background.js")

    start_bulk_guard = background[
        background.index("async function startBulkImport")
        : background.index("async function prepareBulkImport")
    ]
    scan_guard = background[
        background.index("async function scanHistoryConversations")
        : background.index("async function startSelectedBulkImport")
    ]
    assert "isSupportedChatPage(tab.url || \"\")" in start_bulk_guard
    assert "isChatGPTPage(tab.url || \"\")" not in start_bulk_guard
    assert "isSupportedChatPage(tab.url || \"\")" in scan_guard
    assert "isChatGPTPage(tab.url || \"\")" not in scan_guard
    assert "请先打开普通 ChatGPT 会话页" in start_bulk_guard
    assert "请先打开普通 ChatGPT 会话页" in scan_guard


def test_popup_persists_advanced_settings_in_chrome_storage():
    popup_js = read_text("browser-extension/popup.js")

    assert "loadPopupSettings" in popup_js
    assert "savePopupSettings" in popup_js
    assert "advancedImportIntervalSeconds" in popup_js
    assert "advancedMaxBulkConversations" in popup_js
    assert "advancedImportAll" in popup_js
    assert "advancedBulkConfirmed" in popup_js
    assert "chrome.storage.local.set({" in popup_js
    assert "bulkIntervalSecondsInput.addEventListener(\"change\", persistBulkSettings)" in popup_js
    assert "bulkMaxCountInput.addEventListener(\"change\", persistBulkSettings)" in popup_js
    assert "bulkUseAll.addEventListener(\"change\", persistBulkSettings)" in popup_js
    assert "bulkConfirmed.addEventListener(\"change\", persistBulkSettings)" in popup_js


def test_background_keeps_task_state_for_popup_reopen():
    background = read_text("browser-extension/background.js")
    popup_js = read_text("browser-extension/popup.js")

    assert "let taskState = createIdleTaskState()" in background
    assert "function updateTaskState(patch)" in background
    assert "getTaskState" in background
    assert 'type: "getTaskState"' in popup_js
    assert "renderTaskState" in popup_js
    assert "当前任务" in read_text("browser-extension/popup.html")
    assert "最近错误" in read_text("browser-extension/popup.html")


def test_safe_mode_does_not_use_background_tabs_or_debugger_for_current_export():
    background = read_text("browser-extension/background.js")

    assert "exportCurrentConversationSafe" in background
    assert 'chrome.tabs.sendMessage(tab.id, { type: "exportVisibleConversation" })' in background
    assert "captureConversationResponseInBackgroundTab(tab.url || \"\", conversationId)" in background
    assert "if (safeMode) {\n    return exportCurrentConversationSafe" in background


def test_advanced_current_and_bulk_export_use_background_tabs():
    background = read_text("browser-extension/background.js")

    assert "createBackgroundTab" in background
    assert "active: false" in background
    assert "captureConversationResponseInBackgroundTab" in background
    assert "captureConversationResponse(tab, conversationId)" not in background
    assert "chrome.tabs.reload(tab.id" not in background
    assert "closeBackgroundTab(backgroundTab.id)" in background
    assert "captureConversationJsonForBulk(\n          item.conversation_id,\n          baseOrigin\n        )" in background


def test_conversation_list_parser_has_diagnostics_and_common_shapes():
    background = read_text("browser-extension/background.js")
    parser = read_text("browser-extension/conversation-list-parser.js")

    assert "createListDiagnostics" in background
    assert "parseConversationListResponse" in background
    assert "topLevelKeys" in parser
    assert "candidatePaths" in parser
    assert "candidateLengths" in parser
    assert "firstItemKeys" in parser
    assert "responsePreview" in parser
    assert '["data", "results"]' in parser
    assert '["response", "conversations"]' in parser
    assert "edges[].node" in parser
    assert "source.uuid" in parser
    assert "source.name" in parser
    assert "未能从历史列表响应中解析到 conversation_id" in background


def test_popup_shows_history_list_diagnostics_and_mode_notice_changes():
    popup = read_text("browser-extension/popup.html")
    popup_js = read_text("browser-extension/popup.js")

    assert 'id="mode-notice"' in popup
    assert "高级模式已开启" in popup_js
    assert 'id="history-diagnostics"' in popup
    assert 'id="diagnostics-url"' in popup
    assert 'id="diagnostics-status"' in popup
    assert 'id="diagnostics-size"' in popup
    assert 'id="diagnostics-top-level-keys"' in popup
    assert 'id="diagnostics-candidate-paths"' in popup
    assert 'id="diagnostics-candidate-lengths"' in popup
    assert 'id="diagnostics-first-item-keys"' in popup
    assert 'id="diagnostics-preview"' in popup
    assert "renderDiagnostics(state.diagnostics)" in popup_js
    assert "扫描历史会话列表失败：" in popup_js
    assert "批量导出已启动。" in popup_js
    assert "批量导出启动失败：" in popup_js


def test_background_sets_task_diagnostics_on_list_parse_failure():
    background = read_text("browser-extension/background.js")

    assert "diagnostics: diagnosticsFromError(error)" in background
    assert "structureError.diagnostics = diagnostics" in background
    assert "parseError.diagnostics = diagnostics" in background
    assert "prepareBulkImport" in background
    assert "prepared = await prepareBulkImport(tab, bulkOptions)" in background


def test_popup_uses_export_language_and_two_step_bulk_flow():
    popup = read_text("browser-extension/popup.html")
    popup_js = read_text("browser-extension/popup.js")

    assert "导入当前会话" not in popup
    assert "开始同步当前会话" in popup
    assert "完整基线" in popup
    assert "最近完整校准" in popup
    assert "重新校准当前会话" in popup
    assert 'type: "startSyncCurrentConversation"' in popup_js
    assert 'type: "stopRealtimeSync"' in popup_js
    assert 'type: "recalibrateCurrentConversation"' in popup_js
    assert "开发者批量导出" in popup
    assert "一键批量导入历史会话" not in popup
    assert "扫描历史会话列表" in popup
    assert "导出已选择的会话" in popup
    assert "停止批量导出" in popup
    assert "导出间隔秒数" in popup
    assert "最大导出数量" in popup
    assert "全选当前列表" in popup
    assert "renderScannedConversations" in popup_js
    assert "selectedConversationIds" in popup_js
    assert "请先选择至少一个会话。" in popup_js


def test_mvp_popup_hides_experimental_bulk_by_default():
    popup = read_text("browser-extension/popup.html")
    popup_js = read_text("browser-extension/popup.js")

    assert '<section class="bulk-section" id="developer-bulk-section" hidden>' in popup
    assert "<summary>实验功能（暂不推荐）</summary>" in popup
    assert 'id="history-diagnostics" hidden' in popup
    assert "developerBulkSection.hidden = true" in popup_js
    assert "advancedModeSettings.hidden = true" in popup_js


def test_mvp_popup_shows_full_and_partial_baseline_state():
    popup = read_text("browser-extension/popup.html")
    popup_js = read_text("browser-extension/popup.js")

    assert "完整基线" in popup
    assert "当前同步来源" in popup
    assert "完整导出消息数" in popup
    assert "JSON mapping 节点数" in popup
    assert "候选消息节点数" in popup
    assert "part 数量" in popup
    assert "导出 section 数" in popup
    assert "顺序异常数量" in popup
    assert "最后一条导出预览" in popup
    assert "parser warning" in popup
    assert "未建立完整基线" in popup_js
    assert "已建立完整基线" in popup_js
    assert "完整基线疑似不完整" in popup_js
    assert "完整导出疑似不完整，请重新校准或查看诊断。" in popup_js
    assert "当前仅保存了页面可见内容，尚未建立完整基线。" in popup_js
    assert "full snapshot" in popup_js
    assert "full snapshot suspect" in popup_js
    assert "realtime partial" in popup_js


def test_start_sync_requires_full_snapshot_before_enabling_realtime():
    background = read_text("browser-extension/background.js")
    branch = background[
        background.index("if (!status.has_full_snapshot)")
        : background.index("startTask(\"sync-current\", {\n    title: \"启动当前会话实时同步\"")
    ]

    assert "runFullCalibrationForTab(tab, conversationId)" in branch
    assert "const baselineStatus = await getConversationStatus(conversationId)" in branch
    assert "if (!baselineStatus.has_full_snapshot)" in branch
    assert "完整基线建立失败：服务端未确认 has_full_snapshot=true。" in branch
    assert branch.index("if (!baselineStatus.has_full_snapshot)") < branch.index(
        "await enableRealtimeSyncForTab(tab, true)"
    )


def test_content_realtime_payload_is_marked_partial_snapshot():
    content = read_text("browser-extension/content.js")
    background = read_text("browser-extension/background.js")

    assert 'source: "extension-content-realtime"' in content
    assert "is_partial_snapshot: true" in content
    assert 'data.source = "conversation-json-full"' in background
    assert "data.is_partial_snapshot = false" in background


def test_background_does_not_log_or_store_sensitive_auth_material():
    background = read_text("browser-extension/background.js")

    assert "console.log(responseText" not in background
    assert "console.error(responseText" not in background
    assert "Bearer" not in background
    assert "Authorization" not in background
    assert "cookie" not in background.lower()


def test_popup_explains_safe_mode_and_responsible_use():
    popup = read_text("browser-extension/popup.html")
    popup_js = read_text("browser-extension/popup.js")

    assert "安全模式已开启：仅显示当前会话导出，高级完整导出和批量导出入口默认隐藏。" in popup
    assert "建议仅备份你自己账号下的重要会话。请避免短时间内连续导出大量会话。" in popup
    assert "当前模式：" in popup
    assert "安全模式会隐藏高级完整导出和批量导出入口，推荐普通用户保持开启。" in popup
    assert "高级模式会显示完整导出和开发者批量导出，并允许调整访问频率。" in popup
    assert "开始同步当前会话" in popup
    assert 'id="import-mode-help"' in popup
    assert "高级模式冷却秒数" in popup
    assert 'id="advanced-mode-settings"' in popup
    assert 'id="advanced-cooldown-seconds"' in popup
    assert 'min="0"' in popup
    assert 'max="60"' in popup
    assert "批量导出仅在高级模式中显示，并且需要用户确认后才会启动。" in popup
    assert 'id="mode-toggle"' in popup
    assert 'id="developer-bulk-section"' in popup
    assert "开发者批量导出" in popup
    assert "扫描历史会话列表" in popup
    assert "导出已选择的会话" in popup
    assert "停止批量导出" in popup
    assert "导出间隔秒数" in popup
    assert "最大导出数量" in popup
    assert "全部" in popup
    assert "我确认仅用于备份自己账号下可访问的 ChatGPT 会话" in popup
    assert 'type: "setSafeMode"' in popup_js
    assert 'type: "setAdvancedCooldownSeconds"' in popup_js
    assert 'type: "scanHistoryConversations"' in popup_js
    assert 'type: "startSelectedBulkImport"' in popup_js
    assert 'type: "stopBulkImport"' in popup_js
    assert 'type: "getBulkStatus"' in popup_js
    assert "confirm(" in popup_js
    assert "advancedCooldownSeconds" in popup_js
    assert 'importButton.textContent = "开始同步当前会话"' in popup_js
    assert "首次同步会先建立完整基线" in popup_js
    assert "高级模式：开启" in popup_js
    assert "安全模式：开启" in popup_js


def test_safe_mode_keeps_safe_current_import_and_hides_advanced_controls():
    popup_js = read_text("browser-extension/popup.js")

    assert "importButton.hidden = false" in popup_js
    assert "advancedModeSettings.hidden = true" in popup_js
    assert "importButton.disabled = !status.serviceConnected || !status.supported" in popup_js
    assert "developerBulkSection.hidden = true" in popup_js
    assert "bulkExportSelectedButton.disabled =" in popup_js
    assert "!bulkConfirmed.checked || selectedConversationIds().length === 0" in popup_js


def test_background_allows_safe_current_import_and_rejects_safe_bulk_import():
    background = read_text("browser-extension/background.js")

    assert "安全模式下完整导入入口已隐藏，请切换到高级模式后再导入。" not in background
    assert "await enforceImportCooldown(Date.now(), safeMode, advancedCooldownSeconds)" in background
    assert "if (safeMode) {\n    throw new Error(\"请先切换到高级模式，再扫描历史会话列表。\")" in background


def test_readme_states_text_first_and_images_in_development():
    readme = read_text("README.md")

    assert "当前已支持文字导出" in readme
    assert "图片导出仍在开发中" in readme
    assert "不要把当前版本当作完整图片/附件备份工具" in readme
    assert "AI\\_ChatGPTSyncMVPTest" in readme
    assert "如果完整导出失败，不会开启实时同步" in readme
    assert "只有完整 conversation JSON 成功导入后，服务端才会把 `has_full_snapshot` 标记为 `true`" in readme


def test_responsible_use_docs_exist():
    readme = read_text("README.md")
    safety = read_text("docs/SAFETY.md")

    assert "Responsible Use / 安全使用说明" in readme
    assert "This preview is for archiving your own currently opened ChatGPT conversation." in readme
    assert "It does not provide one-click export of all history in v0.1.0-preview." in readme
    assert "Use one active ChatGPT conversation tab at a time." in readme
    assert "设计原则" in safety
    assert "Preview 行为" in safety
    assert "不保存 token" in safety
    assert "不提供一键导出全部历史会话" in safety
    assert "预览版建议一次只同步一个 ChatGPT 会话标签页" in safety
