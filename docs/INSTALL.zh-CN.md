# 安装说明

适用于 `v0.1.0-preview`。

## 1. 准备环境

- Windows
- Python 3.10+
- Chrome / Edge / Opera
- Obsidian Vault

## 2. 克隆项目

```powershell
git clone <repo-url>
cd chatgpt-obsidian-sync
```

## 3. 安装依赖

```powershell
python -m pip install -e .[dev]
```

## 4. 启动本地服务

```powershell
python -m chatgpt_obsidian_sync
```

服务默认运行在：

```text
http://127.0.0.1:8765
```

## 5. 配置 Obsidian Vault

打开：

[http://127.0.0.1:8765/](http://127.0.0.1:8765/)

填写你的 Obsidian Vault 路径，然后点击测试写入。

## 6. 安装浏览器扩展

1. 打开浏览器扩展管理页面。
2. 启用开发者模式。
3. 点击“加载已解压的扩展”。
4. 选择项目里的 `browser-extension/` 文件夹。

## 7. 开始同步

1. 打开一个具体 ChatGPT 会话页：

   ```text
   https://chatgpt.com/c/<conversation_id>
   ```

2. 点击扩展图标。
3. 点击“开始同步当前会话”。
4. 等待完整基线建立。
5. 后续当前会话的新文字消息会实时同步到 Obsidian。

