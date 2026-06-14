# ChatGPT Obsidian Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a runnable local FastAPI service plus Tampermonkey userscript that syncs visible ChatGPT text messages into an Obsidian vault.

**Architecture:** The browser sends raw conversation snapshots to a local FastAPI API. The Python service owns configuration, SQLite persistence, deduplication, Markdown formatting, part splitting, and index regeneration.

**Tech Stack:** Python 3, FastAPI, Uvicorn, SQLite, pytest, Tampermonkey JavaScript.

---

### Task 1: Project Scaffold

**Files:**
- Create: `pyproject.toml`
- Create: `config.json`
- Create: `src/chatgpt_obsidian_sync/__init__.py`
- Create: `tests/conftest.py`

- [ ] Create a Python package with dependencies for FastAPI, Uvicorn, Pydantic, and pytest.
- [ ] Add the default configuration file.
- [ ] Add pytest fixtures for temporary vault/config/database paths.

### Task 2: Config and Models

**Files:**
- Create: `src/chatgpt_obsidian_sync/config.py`
- Create: `src/chatgpt_obsidian_sync/schemas.py`
- Test: `tests/test_config.py`

- [ ] Write failing tests for default config loading and JSON overrides.
- [ ] Implement config loading with Windows-friendly paths.
- [ ] Verify the tests pass.

### Task 3: SQLite Store

**Files:**
- Create: `src/chatgpt_obsidian_sync/store.py`
- Test: `tests/test_store.py`

- [ ] Write failing tests for schema creation, conversation upsert, message insertion, and duplicate skipping.
- [ ] Implement SQLite initialization and insert logic.
- [ ] Verify the tests pass.

### Task 4: Markdown Export

**Files:**
- Create: `src/chatgpt_obsidian_sync/exporter.py`
- Test: `tests/test_exporter.py`

- [ ] Write failing tests for safe folder names, callout rendering, 10-message part splitting, and `index.md` generation.
- [ ] Implement Markdown export from stored messages.
- [ ] Verify the tests pass.

### Task 5: FastAPI App

**Files:**
- Create: `src/chatgpt_obsidian_sync/app.py`
- Create: `src/chatgpt_obsidian_sync/__main__.py`
- Test: `tests/test_api.py`

- [ ] Write failing API tests for `/health` and `POST /api/messages`.
- [ ] Implement app factory, CORS for local browser requests, and API endpoints.
- [ ] Verify the tests pass.

### Task 6: Userscript and README

**Files:**
- Create: `userscript/chatgpt-obsidian-sync.user.js`
- Create: `README.md`

- [ ] Add a Tampermonkey userscript that scans `[data-message-author-role]` messages and posts snapshots to the local service.
- [ ] Document install, startup, userscript installation, and manual testing.
- [ ] Run the full test suite.

### Self-Review

The plan covers the required local service, SQLite persistence, DOM scanning userscript, `/api/messages`, server-side deduplication, Obsidian folder structure, 10-message part files, `index.md`, callout Markdown, configurable settings, README, and first-version exclusions.
