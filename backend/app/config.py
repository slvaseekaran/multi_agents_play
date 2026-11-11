"""Runtime configuration (environment variables, sane defaults)."""
import os
import shutil
from pathlib import Path

PORT = int(os.environ.get("PORT", "7777"))
DATA_DIR = Path(os.environ.get("DASH_DATA_DIR", Path(__file__).resolve().parent.parent / "data"))
UI_DIST = Path(os.environ.get("DASH_UI_DIST", Path(__file__).resolve().parent.parent.parent / "dist"))

LOCAL_HOME = Path.home() / ".claude"
# Extra Claude homes (e.g. /mnt/c/Users/<you>/.claude) are history-only.
HOMES = [LOCAL_HOME] + [Path(p) for p in os.environ.get("CLAUDE_HOMES", "").split(os.pathsep) if p]
OFFLINE_DAYS = float(os.environ.get("OFFLINE_DAYS", "7"))
OFFLINE_MAX = int(os.environ.get("OFFLINE_MAX", "30"))
_MODES = {"acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan"}
PERMISSION_MODE = os.environ.get("DASH_PERMISSION_MODE", "auto")
if PERMISSION_MODE not in _MODES:  # the value ends up on a command line (and in a tmux shell string): allow-list it
    PERMISSION_MODE = "auto"
USAGE_POLL_MIN = float(os.environ.get("USAGE_POLL_MIN", "15"))
CONTEXT_WINDOW = int(os.environ.get("DASH_CONTEXT_WINDOW", "1000000"))
PEER_WINDOW_S = 30 * 60

CLAUDE_BIN = os.environ.get("CLAUDE_BIN") or shutil.which("claude") or str(Path.home() / ".local" / "bin" / "claude")

# Browser origins allowed to call the API: the Tauri webview (Windows/Linux/mac) and the dev server.
ALLOWED_ORIGINS = [
    "http://tauri.localhost", "https://tauri.localhost", "tauri://localhost",
    "http://localhost:1420", f"http://localhost:{PORT}", f"http://127.0.0.1:{PORT}",
] + [o for o in os.environ.get("DASH_ORIGINS", "").split(",") if o]
ALLOWED_HOSTS = {"localhost", "127.0.0.1", "[::1]"}
