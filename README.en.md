# ChatGPT Obsidian Sync

**v0.1.0-preview**

Primary Chinese README: [README.md](README.md)

## Project Overview

ChatGPT Obsidian Sync is an unofficial local-first tool to archive the current ChatGPT conversation into an Obsidian vault.

It exports and syncs the currently opened ChatGPT conversation as Obsidian Markdown. It is designed for people who want to preserve, organize, and review ChatGPT conversations over time.

The current preview focuses on one main workflow: open a concrete ChatGPT conversation, click **Start syncing current conversation**, establish a full baseline, and continue syncing new text messages from that same conversation into your local vault.

## Who Is This For

- Obsidian users.
- People who use ChatGPT for writing, coding, research, or learning.
- People who need to preserve long conversations, project discussions, creative settings, or knowledge notes.
- People who do not want to manually copy and paste ChatGPT conversations.
- Users who prefer keeping their conversation archive in a local vault.

## Currently Supported

- Full export of the current ChatGPT conversation.
- Automatic part splitting for long conversations.
- Realtime text sync for the currently opened conversation.
- Rebuild current conversation notes from local data.
- Local FastAPI service.
- Local SQLite storage.
- Obsidian Markdown output.
- Idle behavior on non-conversation pages.
- No ChatGPT token or cookie storage.
- No third-party upload.

The preview supports text export. Realtime sync is text-only.

## Not Supported Yet

- Image sync.
- Attachment sync.
- One-click export of all history.
- Batch history export.
- Multiple ChatGPT tabs syncing at the same time.
- Browser store distribution.
- Mobile sync.

Images and attachments are not part of v0.1.0-preview.

## Roadmap

The following items are possible future directions. They are not promised for any specific date:

- Image and attachment sync.
- A friendlier installer.
- A clearer Obsidian template system.
- Selective export of historical conversations.
- Multi-vault support.
- Better error diagnostics.
- Browser store versions.

The roadmap only describes possible directions and does not commit to an implementation timeline.

## Installation

1. Clone this repository.

   ```powershell
   git clone <repo-url>
   cd chatgpt-obsidian-sync
   ```

2. Install Python dependencies.

   ```powershell
   python -m pip install -e .[dev]
   ```

3. Start the local service.

   ```powershell
   python -m chatgpt_obsidian_sync
   ```

4. Open the local settings page:

   [http://127.0.0.1:8765/](http://127.0.0.1:8765/)

5. Configure your Obsidian Vault path and run the test write.

6. Load the browser extension as an unpacked extension.

   - Open the Chrome / Edge / Opera extension management page.
   - Enable Developer mode.
   - Choose **Load unpacked**.
   - Select the `browser-extension/` folder.

7. Open a concrete ChatGPT conversation page:

   ```text
   https://chatgpt.com/c/<conversation_id>
   ```

8. Click **Start syncing current conversation** in the extension popup.

## Usage

1. Open `https://chatgpt.com/c/<conversation_id>`.
2. Click **Start syncing current conversation**.
3. The first sync establishes a full baseline.
4. Wait for Obsidian to generate `index.md` and part files such as `part-001.md`.
5. New text messages will be synced as you continue the conversation.
6. Click **Stop realtime sync** when you want to pause.
7. Click **Rebuild current conversation notes** if the Markdown files need to be regenerated from the local database.

Only a successful full conversation JSON import can establish the local baseline. If full export fails, realtime sync will not start.

Typical output structure:

```text
AI/_ChatGPTSyncMVPTest/
└── Conversation title - conversation_id/
    ├── index.md
    ├── part-001.md
    ├── part-002.md
    └── ...
```

## FAQ / Troubleshooting

### What if the content script is not detected?

Refresh the current ChatGPT conversation page and retry. If you just reloaded the extension, some already-open pages may need to be refreshed before the page script is detected.

### What if Obsidian or OneDrive locks the files?

Retry later, or click **Rebuild current conversation notes**. Obsidian, OneDrive, antivirus software, or indexing tools may briefly lock Markdown files.

### Why are images not synced?

v0.1.0-preview supports text only. Image and attachment sync are possible future work.

### Can I export all ChatGPT history with one click?

Not currently. v0.1.0-preview focuses only on the currently opened conversation.

### Can I sync multiple ChatGPT tabs at the same time?

The current preview recommends syncing one conversation tab at a time.

## Privacy

- The extension does not save ChatGPT cookies.
- The extension does not save Authorization or Bearer tokens.
- The tool never asks you to copy a token.
- Conversation content is sent only to the local service at `http://127.0.0.1:8765`.
- Data is written to the Obsidian Vault configured by the user.
- No data is uploaded to third-party servers by this project.

See [docs/PRIVACY.md](docs/PRIVACY.md).

## Disclaimer

This project is unofficial. It is not affiliated with, endorsed by, or sponsored by OpenAI.

Users should only back up conversations they can access in their own ChatGPT account. Users are responsible for complying with OpenAI Terms of Use and applicable laws.

See [docs/DISCLAIMER.md](docs/DISCLAIMER.md).

## Sponsorship

The basic features of this project will remain open-source and free. If this tool saves you time organizing ChatGPT conversations and Obsidian notes, voluntary support is welcome. Sponsorship is entirely optional and does not affect access to the basic features.

See [docs/SPONSORS.zh-CN.md](docs/SPONSORS.zh-CN.md).

## Known Limits

- ChatGPT page DOM changes may break sync.
- Branched conversations only guarantee the current main chain.
- Images and attachments are not supported yet.
- Very long conversations may take longer during the first export.
- The current preview recommends syncing one conversation tab at a time.
- After reloading the extension, some pages may need a refresh before the content script is detected.
- OneDrive / Obsidian file locks may require retrying later or clicking **Rebuild current conversation notes**.

See [docs/KNOWN_LIMITS.md](docs/KNOWN_LIMITS.md).

## Development

Developer notes live in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

```powershell
python -m pytest -q
node --check browser-extension\background.js
node --check browser-extension\popup.js
node --check browser-extension\content.js
```
