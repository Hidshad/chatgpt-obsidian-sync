# Known Limits

This document applies to `v0.1.0-preview`.

## Current Scope

The preview release focuses on the current open ChatGPT conversation and text-only Obsidian Markdown output.

## Limits

- Images are not synced.
- Attachments are not synced.
- One-click export of all ChatGPT history is not supported.
- Batch history export is not part of the supported preview workflow.
- Multiple ChatGPT tabs syncing at the same time is not supported.
- Mobile sync is not supported.
- Browser Web Store publishing is not included.

## ChatGPT Page Changes

Realtime sync depends on the ChatGPT web page structure. If ChatGPT changes its DOM, realtime sync may stop detecting messages until the extension is updated.

## Branches

Conversation JSON can contain branches. The preview targets the current main chain. Branched or alternate paths may not be exported as separate branches.

## Long Conversations

Very long conversations may take longer during the first full export. The output is split into part files to keep Markdown files manageable.

## File Locks

Obsidian, OneDrive, antivirus software, or indexing tools may temporarily lock Markdown files. If a write fails or appears stale, stop realtime sync and click **重新生成当前会话笔记** after the lock clears.

## Extension Reloads

After reloading the browser extension, some already-open ChatGPT pages may need to be refreshed before the content script is detected again. If the popup says the page script cannot be detected, refresh the current ChatGPT conversation page and retry.
