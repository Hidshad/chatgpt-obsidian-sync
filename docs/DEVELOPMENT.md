# Development

面向开发者的项目说明。普通用户请看根目录 `README.md`。

## 项目结构

```text
chatgpt-obsidian-sync/
  browser-extension/             # MV3 浏览器扩展
    content.js                   # 扩展实时文字和图片同步
  config.json                    # 本地配置
  docs/DEVELOPMENT.md
  src/chatgpt_obsidian_sync/
    app.py                       # FastAPI 服务和设置页
    config.py                    # 配置读取/保存
    exporter.py                  # Obsidian Markdown 输出
    importer.py                  # ChatGPT conversation JSON 主链解析
    import_json.py               # 本地 JSON 文件导入 CLI
    schemas.py                   # API schema
    store.py                     # SQLite conversations/messages
  tests/
  userscript/chatgpt-obsidian-sync.user.js
```

## 本地开发

```powershell
cd D:\codex\chatgpt-obsidian-sync
python -m pip install -e ".[dev]"
python -m chatgpt_obsidian_sync
```

服务默认监听：

```text
http://127.0.0.1:8765
```

配置从 `config.json` 读取。默认 `base_dir` 是 `AI\_ChatGPTSyncTest`，不要在测试阶段改成正式目录。

## 测试

```powershell
python -m pytest -q
node --check browser-extension/background.js
node --check browser-extension/popup.js
```

## API

### `GET /health`

返回服务状态：

```json
{ "status": "ok" }
```

### `GET /`

本地设置页。显示服务状态、当前配置、Vault 路径状态、测试写入和扩展安装说明。

### `GET /api/config`

返回当前配置和 Vault 状态：

```json
{
  "ok": true,
  "config": {
    "vault_path": "C:\\Path\\To\\ObsidianVault",
    "base_dir": "AI/_ChatGPTSyncTest",
    "messages_per_part": 10,
    "server_port": 8765
  },
  "vault_exists": true,
  "output_base": "C:\\Users\\shawn\\OneDrive\\Obsidian\\AI\\_ChatGPTSyncTest"
}
```

### `POST /api/config`

保存用户配置到 `config.json`。支持字段：

```json
{
  "vault_path": "C:\\Path\\To\\ObsidianVault",
  "base_dir": "AI\\_ChatGPTSyncTest",
  "messages_per_part": 10,
  "server_port": 8765
}
```

### `POST /api/test-write`

验证 Vault 可写。成功返回测试文件路径。

### `POST /api/messages`

实时同步入口。当前主线调用方是 browser-extension 的 `content.js`；legacy userscript 仍可作为开发者 fallback 调用。服务端接收当前 DOM 中可见消息快照，按 `conversation_id` 和 message `id` 去重，并重新生成 Obsidian 文件。

### `POST /api/conversation/import`

完整会话导入入口。接收 ChatGPT `/backend-api/conversation/<conversation_id>` response JSON。

服务端会：

- 读取 `title`、`conversation_id`、`mapping`
- 从 `client-created-root` 开始沿 `children[0]` 遍历主链
- 如果没有 `client-created-root`，回退到第一个 `parent is None` 的 root
- 跳过 `message=null`
- 跳过非 `text` content
- 只保留 `role=user` 和 `role=assistant`
- 合并 `content.parts` 中的字符串
- 用 `message.id` 去重、更新和排序
- 清理不在本次主链里的旧 DOM 消息
- 重新生成 `index.md` 和 `part-*.md`

错误响应统一尽量返回：

```json
{
  "ok": false,
  "error": "Vault 路径不存在，请先在设置页选择 Obsidian Vault 文件夹。"
}
```

### `POST /api/assets`

当前页面实时图片同步入口。浏览器端负责读取图片内容，并把 base64 发给本地服务：

```json
{
  "conversation_id": "conv-id",
  "title": "Chat title",
  "message_id": "msg-id",
  "source_url": "https://...",
  "mime_type": "image/png",
  "base64_data": "...",
  "suggested_ext": ".png"
}
```

服务端会：

- base64 解码
- 计算 sha256
- 在同一 conversation_id 内按 sha256 去重
- 保存到 `<conversation folder>/assets/`
- 写入 `attachments` 表
- 返回 `local_relative_path`

成功响应：

```json
{
  "ok": true,
  "local_relative_path": "assets/img-xxxxxxxxxxxx.png",
  "filename": "img-xxxxxxxxxxxx.png",
  "sha256": "..."
}
```

导出 Markdown 时，message 正文后会追加：

```markdown
![[assets/img-xxxxxxxxxxxx.png]]
```

## Browser Extension 技术细节

`browser-extension` 是普通用户主线入口。

核心行为：

- popup 管理导入当前会话、高级批量导入和实时同步开关
- `background.js` 负责完整导入和高级批量导入
- `content.js` 负责实时文字和图片同步
- `content.js` 扫描 `[data-message-author-role]`
- 扫描每条消息里的 `img[src]`
- 优先读取 `img.currentSrc`，回退到 `img.src`
- 支持 `data:image`、`blob:`、`https:` 图片源
- 图片先 POST 到 `/api/assets`，再在 `/api/messages` 中关联返回的 `local_relative_path`
- POST 到 `http://127.0.0.1:8765/api/messages`

实时同步默认关闭，由 popup 写入 `chrome.storage.local`：

```json
{
  "realtimeSyncEnabled": false,
  "realtimeSyncIntervalMs": 15000
}
```

content script 会把最近同步时间、消息数、图片数和最近错误写回 `chrome.storage.local` 供 popup 展示。

## Userscript 技术细节

`userscript/chatgpt-obsidian-sync.user.js` 保留为 legacy / developer fallback。普通用户不再需要安装 Tampermonkey。

保留行为：

- 可扫描 `[data-message-author-role]`
- 可调用本地 `/api/messages`
- 暴露 `exportFullChatGPTConversationToObsidian()`
- 保留完整导入尝试逻辑，但由于 ChatGPT 登录态限制，部分账号/会话可能返回 `conversation_inaccessible`
 
扩展完整导入实现方式：

- Manifest V3
- popup 展示本地服务状态、conversation ID、页面支持状态和导入按钮
- background 在用户点击导入时临时调用 `chrome.debugger`
- 启用 `Network`
- 刷新当前 ChatGPT 会话页
- 捕获 `/backend-api/conversation/<conversation_id>` response body
- POST 到本地 `/api/conversation/import`
- 导入结束、失败或超时后自动 detach

限制：

- 只支持普通会话页 `/c/<conversation_id>`，包括 GPT 路径里的 `/g/<g-id>/c/<conversation_id>`
- 不支持 `/share/<id>`
- 不读取或保存 Authorization token
- 不保存 cookie
- 不做浏览器自动控制

## 手动 JSON CLI

兜底导入命令：

```powershell
python -m chatgpt_obsidian_sync.import_json data\conversation.json
```

它复用 `config.py`、`importer.py`、`store.py`、`exporter.py`，行为与 `/api/conversation/import` 保持一致。
