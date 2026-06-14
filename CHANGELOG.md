# Changelog

## v0.1.0-preview

Preview release focused on the single current-conversation workflow.

### Added

- Current conversation full export.
- Long conversation part splitting.
- Realtime text sync for current conversation.
- Local SQLite storage.
- Obsidian Markdown exporter.
- Rebuild current conversation notes.
- Non-conversation page idle mode.
- Order normalization for exported messages.

### Local-First Design

- No ChatGPT token storage.
- No ChatGPT cookie storage.
- No third-party upload by this project.
- Conversation data is sent to `127.0.0.1` and written to the configured local vault.

### Known limitations

- No image/attachment sync yet.
- No full history batch export yet.
- One active realtime conversation recommended.
- ChatGPT UI changes may break extraction.
