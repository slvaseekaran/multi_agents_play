# Agent Dashboard (Windows desktop app for Claude Code in WSL2)

Tauri shell (Windows) + React/TypeScript UI + FastAPI backend (WSL2). Manages the Claude Code CLI sessions in WSL.

    Windows ── Tauri app ──(wsl.exe, hidden)──▶ FastAPI backend (WSL2, 127.0.0.1:7777) ──▶ claude CLI sessions
                  └─ React UI ◀────────── HTTP + SSE ───────────────┘

## Install (Windows)
Run `Install-AgentDashboard.cmd` (or `scripts\install-windows.ps1`). It sets up the WSL backend, builds the app,
and creates the **Agent Dashboard** desktop + Start menu shortcuts. Needs Node, Rust and VS Build Tools (C++);
add `-InstallPrerequisites` to have winget install the missing ones.

## Develop
    backend/run.sh                      # backend only; open http://localhost:7777 (serves ./dist if built)
    npm install && npm run dev          # UI on :1420 talking to the backend on :7777
    npm run tauri dev                   # on Windows: full desktop app

## How sessions are handled (nothing is replaced)
- Live sessions come from `~/.claude/sessions/<pid>.json`; history from `~/.claude/projects/**/<id>.jsonl`.
- Session running in **tmux**: prompts are pasted into the real pane; the same session answers.
- **Offline** session: `claude -p --resume <id>` appends to the same session (full context kept).
- Session open in a **plain terminal**: never written to. Sending requires an explicit "fork" confirmation and creates a
  new session with copied history; the original stays untouched.

## Configuration
Env vars for the backend: `PORT` (7777), `DASH_PERMISSION_MODE` (`acceptEdits`, for headless turns),
`OFFLINE_DAYS`, `OFFLINE_MAX`, `USAGE_POLL_MIN`, `CLAUDE_HOMES`.
Desktop app config: `%APPDATA%\AgentDashboard\config.json`; backend log: `%LOCALAPPDATA%\AgentDashboard\backend.log`.

## Third-party
Bundled fonts (`public/fonts`): JetBrains Mono and Share Tech Mono, both under the SIL Open Font License 1.1.
Built with Tauri, React, FastAPI and uvicorn. Not affiliated with Anthropic; it drives the `claude` CLI you already have installed.
