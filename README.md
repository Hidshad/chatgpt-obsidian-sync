# ChatGPT Obsidian Sync

**v0.1.0-preview**

中文文档为主：[English README](README.en.md)

## 项目简介

ChatGPT Obsidian Sync 是一个非官方、本地优先的 ChatGPT 当前会话归档工具。它可以把当前打开的 ChatGPT 会话导出并同步为 Obsidian Markdown，适合需要长期保存、整理和复盘 ChatGPT 对话的用户。

英文简介：Unofficial local-first tool to archive the current ChatGPT conversation into an Obsidian vault.

本项目当前聚焦一个清晰主流程：打开一个 ChatGPT 具体会话页，点击“开始同步当前会话”，首次建立完整基线，后续继续将当前会话的新文字消息同步到本地 Obsidian Vault。

## 适合谁使用

- Obsidian 用户。
- 长期使用 ChatGPT 做写作、编程、研究、学习的人。
- 需要保存长会话、项目讨论、创作设定、知识整理的人。
- 不想手动复制粘贴 ChatGPT 对话的人。
- 希望对话内容优先保存在自己本地 Vault 的用户。

## 当前已经支持

- 当前 ChatGPT 会话完整导出。
- 长会话自动分 part。
- 当前打开会话的文字实时同步。
- 重新生成当前会话笔记。
- 本地 FastAPI 服务。
- SQLite 本地存储。
- Obsidian Markdown 输出。
- 非会话页静默待机。
- 不保存 ChatGPT token/cookie。
- 不上传第三方服务器。

当前已支持文字导出。实时同步只同步文字。

## 当前暂不支持

- 图片同步。
- 附件同步。
- 一键导出全部历史会话。
- 批量历史导出。
- 多个 ChatGPT tab 同时实时同步。
- 浏览器商店正式安装。
- 移动端同步。

图片导出仍在开发中，图片/附件同步仍在开发中；不要把当前版本当作完整图片/附件备份工具。

## Roadmap / 后续可能计划

以下内容仅代表可能方向，不承诺具体实现时间：

- 图片/附件同步。
- 更友好的安装器。
- 更清晰的 Obsidian 模板系统。
- 历史会话选择性导出。
- 多 Vault 支持。
- 更完善的错误诊断。
- 浏览器商店版本。

Roadmap 仅代表可能方向，不承诺具体实现时间。

## 安装说明

1. 克隆仓库。

   ```powershell
   git clone https://github.com/Hidshad/chatgpt-obsidian-sync.git
   cd chatgpt-obsidian-sync
   ```

2. 安装 Python 依赖。

   ```powershell
   python -m pip install -e .[dev]
   ```

3. 启动本地服务。

   ```powershell
   python -m chatgpt_obsidian_sync
   ```

4. 打开本地设置页。

   [http://127.0.0.1:8765/](http://127.0.0.1:8765/)

5. 配置 Obsidian Vault 路径，并点击测试写入。

6. 浏览器加载 unpacked extension。

   - 打开 Chrome / Edge / Opera 的扩展管理页面。
   - 开启开发者模式。
   - 点击“加载已解压的扩展”。
   - 选择项目中的 `browser-extension/` 文件夹。

7. 打开 ChatGPT 具体会话页。

   ```text
   https://chatgpt.com/c/<conversation_id>
   ```

8. 点击扩展 popup 中的“开始同步当前会话”。

默认测试输出目录示例：`AI\_ChatGPTSyncMVPTest`。

## 使用方法

1. 打开一个 ChatGPT 具体会话页：`https://chatgpt.com/c/<conversation_id>`。
2. 点击“开始同步当前会话”。
3. 首次同步会建立完整基线。
4. 等待 Obsidian 中生成 `index.md` 和 `part-001.md`、`part-002.md` 等 part 文件。
5. 后续继续聊天会实时同步文字。
6. 需要暂停时点击“停止实时同步”。
7. 如果 Markdown 文件异常，可点击“重新生成当前会话笔记”。

只有完整 conversation JSON 成功导入后，服务端才会把 `has_full_snapshot` 标记为 `true`；如果完整导出失败，不会开启实时同步。

典型输出结构：

```text
AI/_ChatGPTSyncMVPTest/
└── 会话标题 - conversation_id/
    ├── index.md
    ├── part-001.md
    ├── part-002.md
    └── ...
```

## 常见问题 / 故障处理

### content script 未检测到怎么办？

刷新当前 ChatGPT 会话页后重试。如果刚刚重新加载过扩展，部分页面可能需要刷新后才能检测到页面脚本。

### Obsidian 或 OneDrive 占用文件怎么办？

稍后重试，或点击“重新生成当前会话笔记”。OneDrive、Obsidian、杀毒软件或索引服务有时会短暂占用 Markdown 文件。

### 为什么没有同步图片？

v0.1.0-preview 只支持文字。图片/附件同步仍在后续计划中。

### 可以一键导出全部历史会话吗？

当前不支持。v0.1.0-preview 只面向当前打开的会话。

### 可以同时同步多个 ChatGPT 标签页吗？

当前建议一次只同步一个会话 tab。

### 完整基线失败后会怎样？

如果完整导出失败，不会开启实时同步。你可以刷新当前 ChatGPT 会话页、确认本地服务正常后再点击“开始同步当前会话”。

## 隐私与安全

- 不保存 ChatGPT cookie。
- 不保存 Authorization / Bearer token。
- 不要求用户复制 token。
- 对话内容只发送到 `127.0.0.1` 本地服务。
- 数据写入用户配置的 Obsidian Vault。
- 不上传第三方服务器。

更多说明见 [docs/PRIVACY.md](docs/PRIVACY.md)。

## Responsible Use / 安全使用说明

- This preview is for archiving your own currently opened ChatGPT conversation.
- It does not provide one-click export of all history in v0.1.0-preview.
- Use one active ChatGPT conversation tab at a time.
- 请只备份你自己账号下有权访问的会话。
- 如果 ChatGPT 出现验证、限制、异常或频繁失败，请停止使用并稍后重试。

## 免责声明

本项目是非官方项目，与 OpenAI 没有关联，也不由 OpenAI 认可、赞助或背书。

用户应只备份自己 ChatGPT 账号下有权访问的会话，并自行遵守 OpenAI 使用条款和适用法律法规。

English: This project is unofficial. It is not affiliated with, endorsed by, or sponsored by OpenAI. Users should only back up conversations they can access in their own ChatGPT account. Users are responsible for complying with OpenAI Terms of Use and applicable laws.

更多说明见 [docs/DISCLAIMER.md](docs/DISCLAIMER.md)。

## 赞助说明

本项目会保持基础功能开源免费。如果它帮你节省了整理 ChatGPT 对话和 Obsidian 笔记的时间，欢迎自愿支持后续维护。赞助完全自愿，不影响基础功能使用。

赞助说明见 [docs/SPONSORS.zh-CN.md](docs/SPONSORS.zh-CN.md)。

## 已知限制

- ChatGPT 页面 DOM 变化可能导致同步失效。
- 分支会话只保证当前主链。
- 图片/附件暂不支持。
- 极长会话首次导出可能需要较长时间。
- 当前 preview 版建议一次只同步一个会话 tab。
- 重新加载扩展后，个别页面可能需要刷新后才能检测到 content script。
- OneDrive / Obsidian 文件占用时，可能需要稍后重试或点击“重新生成当前会话笔记”。

更多说明见 [docs/KNOWN_LIMITS.md](docs/KNOWN_LIMITS.md)。

## 开发与测试

开发说明见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)。

```powershell
python -m pytest -q
node --check browser-extension\background.js
node --check browser-extension\popup.js
node --check browser-extension\content.js
```
