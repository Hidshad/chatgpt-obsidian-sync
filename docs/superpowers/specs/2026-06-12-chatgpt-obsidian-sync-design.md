# ChatGPT Obsidian Sync Design

## Goal

Create a local-only first version of `chatgpt-obsidian-sync` that copies visible text messages from the official ChatGPT web UI into a local Obsidian vault.

## Scope

The first version supports text messages only. It does not download images, attachments, ChatGPT backend JSON, browser automation output, or any OpenAI API data.

## Architecture

The system has two parts:

- A Tampermonkey userscript running on `chatgpt.com` scans DOM nodes matching `[data-message-author-role]` and sends message snapshots to the local service.
- A Python FastAPI service listens on `http://127.0.0.1:8765`, stores conversations and messages in SQLite, deduplicates by `conversation_id` and `message_id`, and writes Obsidian Markdown files.

The userscript is deliberately thin. It does not split files, format Markdown, or decide storage policy.

## Configuration

`config.json` controls:

- `vault_path`: default `C:\Path\To\ObsidianVault`
- `base_dir`: default `AI\_ChatGPTSyncTest` during testing to avoid old Tampermonkey output conflicts
- `messages_per_part`: default `10`
- `server_port`: default `8765`

## Data Model

SQLite stores:

- `conversations`: `id`, `title`, timestamps
- `messages`: `id`, `conversation_id`, `role`, `content`, `position`, timestamps

Message IDs are generated in the browser from page-visible identity where possible and content fallback when needed. The service enforces uniqueness for `(conversation_id, id)`.

## Obsidian Output

Each conversation is written to:

`<vault_path>/<base_dir>/<safe title> - <conversation_id>/`

The first version defaults to `AI/_ChatGPTSyncTest`. The user can manually change `config.json` to the formal directory after confirming the sync is stable.

Every `messages_per_part` messages are written to one part file:

- `part-001.md`
- `part-002.md`
- `part-003.md`

`index.md` is regenerated on every successful sync and links to each part.

Message Markdown uses Obsidian callouts:

```markdown
> [!tip] 🧑 User
> message text

---

> [!note] 🤖 Assistant
> message text
```

## API

`POST /api/messages` accepts one conversation payload containing:

- `conversation_id`
- `title`
- `messages`

The service returns saved/skipped counts and output path information.

`GET /health` returns service status for manual testing.

## Testing

Automated tests cover:

- Config loading defaults and overrides
- Database insertion and deduplication
- Markdown callout rendering
- Part file generation every 10 messages
- API ingestion and file output

Manual testing uses a sample `curl` payload and Tampermonkey on a real ChatGPT conversation page.
