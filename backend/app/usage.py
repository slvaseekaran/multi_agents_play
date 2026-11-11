"""Claude plan usage (session and weekly windows). The CLI reports every window it knows as a `rate_limit_event`
(`unifiedWindows`); a one-line Haiku call (about $0.0003) refreshes it. It runs every few minutes, and right after
an agent finishes working, so the numbers track what `/usage` shows in the CLI."""
import asyncio
import json
import tempfile
import time

from . import state
from .config import CLAUDE_BIN, USAGE_POLL_MIN


def _migrate(u: dict | None) -> dict | None:
    if not u or "windows" in u:
        return u
    w = {}
    if u.get("fiveHour"):
        w["five_hour"] = u["fiveHour"]
    if u.get("sevenDay"):
        w["seven_day"] = u["sevenDay"]
    return {"windows": w, "updatedAt": u.get("updatedAt")}


current: dict | None = _migrate(state.get().get("usage"))
_on_change = None
_ping_lock = asyncio.Lock()
_last_ping = 0.0
_pending = False
_tasks: set = set()


def update(info: dict | None) -> None:
    global current
    raw = (info or {}).get("unifiedWindows") or {}
    nxt = {k: {"utilization": v.get("utilization"), "resetsAt": v.get("resetsAt")}
           for k, v in raw.items() if isinstance(v, dict) and v.get("resetsAt")}
    if not nxt:
        return
    current = {"windows": {**((current or {}).get("windows") or {}), **nxt}, "updatedAt": int(time.time() * 1000)}
    state.get()["usage"] = current
    state.save()
    if _on_change:
        _on_change(current)


async def ping() -> None:
    global _last_ping
    if _ping_lock.locked():
        return
    async with _ping_lock:
        _last_ping = time.time()
        try:
            p = await asyncio.create_subprocess_exec(
                CLAUDE_BIN, "-p", "--model", "haiku", "--no-session-persistence", "--tools", "", "--disable-slash-commands",
                "--strict-mcp-config", "--system-prompt", "Reply with: ok", "--output-format", "stream-json", "--verbose",
                cwd=tempfile.gettempdir(), stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL, limit=16 * 1024 * 1024)
            p.stdin.write(b"ok")
            p.stdin.close()

            async def read():
                async for line in p.stdout:
                    try:
                        o = json.loads(line)
                    except ValueError:
                        continue
                    if o.get("type") == "rate_limit_event":
                        update(o.get("rate_limit_info"))

            await asyncio.wait_for(read(), 60)
            await p.wait()
        except (OSError, asyncio.TimeoutError):
            try:
                p.kill()  # never leave a stuck probe behind
            except (UnboundLocalError, ProcessLookupError):
                pass


def request_refresh(delay: float = 15.0) -> None:
    """Refresh soon (debounced): called when an agent finishes work, since that is when usage just changed."""
    global _pending
    if _pending:
        return
    _pending = True

    async def go():
        global _pending
        try:
            await asyncio.sleep(delay)
            if time.time() - _last_ping > 300:
                await ping()
        finally:
            _pending = False

    t = asyncio.create_task(go())
    _tasks.add(t)
    t.add_done_callback(_tasks.discard)


async def run(on_change) -> None:
    global _on_change
    _on_change = on_change
    if not current or time.time() * 1000 - (current.get("updatedAt") or 0) > 60000:
        await ping()
    while True:
        await asyncio.sleep(USAGE_POLL_MIN * 60)
        await ping()
