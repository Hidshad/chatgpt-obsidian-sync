# Privacy

ChatGPT Obsidian Sync is designed as a local-first tool.

## What The Tool Does

- Reads the currently open ChatGPT conversation page through the browser extension.
- Sends conversation text to the local service at `http://127.0.0.1:8765`.
- Stores conversation metadata and messages in a local SQLite database.
- Writes Markdown files into your configured Obsidian Vault.

## What The Tool Does Not Do

- It does not save ChatGPT cookies.
- It does not save Authorization or Bearer tokens.
- It does not ask you to copy tokens from DevTools.
- It does not upload your conversations to a third-party service.
- It does not provide cloud sync.

## Local Data

Local data may include:

- Conversation IDs.
- Conversation titles.
- Message roles and text.
- Export status and diagnostic counts.
- Local Obsidian output paths.

You control the local database, config file, extension installation, and Obsidian Vault.

