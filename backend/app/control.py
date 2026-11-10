"""Sending prompts: headless `claude -p --resume` (managed) or tmux paste (live terminal).

Managed turns use the CLI's host protocol (`--input-format stream-json --permission-prompt-tool stdio`): when the
agent needs approval (a permission prompt, or a question for the user) the CLI emits a `control_request`; we
surface it in the UI and answer with a `control_response`, exactly like pressing Accept in a terminal.
"""
import asyncio
import json
import os
import shlex
import shutil
import subprocess
import time
from dataclasses import dataclass, field

from . import discovery, usage
from .config import CLAUDE_BIN, PERMISSION_MODE

TMUX_KEYS = {"Enter", "Escape", "Up", "Down", "Left", "Right", "Tab", "BTab", "BSpace", "Home", "End", "PageUp", "PageDown",
             "C-c", "C-d", "C-o", "C-r", "y", "n", *"123456789"}
SESSION_PREFIX = "dash-"


@dataclass
class Run:
    proc: asyncio.subprocess.Process
    started: float = field(default_factory=time.time)
    pending: dict = field(default_factory=dict)  # request_id -> {"future": Future, "payload": dict}
    write_lock: asyncio.Lock = field(default_factory=asyncio.Lock)


runs: dict[str, Run] = {}
starting: set[str] = set()  # sessions being launched in tmux
_tasks: set = set()  # strong refs so background tasks are not garbage-collected


def is_running(session_id: str) -> bool:
    return session_id in runs


def permissions_for(session_id: str) -> list[dict]:
    r = runs.get(session_id)
    return [p["payload"] for p in r.pending.values()] if r else []


def send_tmux(target: str, text: str) -> None:
    """Type a prompt into the real Claude Code TUI. Single lines are typed key by key, so slash commands
    (/clear, /compact, /model ...) behave exactly as in a terminal; multi-line text uses bracketed paste."""
    if "\n" not in text:
        subprocess.run(["tmux", "send-keys", "-t", target, "-l", "--", text], check=True, timeout=5)
        time.sleep(0.35)  # let the slash-command menu settle before Enter
    else:
        subprocess.run(["tmux", "load-buffer", "-b", "dash", "-"], input=text.encode(), check=True, timeout=5)
        subprocess.run(["tmux", "paste-buffer", "-p", "-d", "-b", "dash", "-t", target], check=True, timeout=5)
        time.sleep(0.2)
    subprocess.run(["tmux", "send-keys", "-t", target, "Enter"], check=True, timeout=5)


def tmux_ok() -> bool:
    return bool(shutil.which("tmux"))


def session_name(session_id: str) -> str:
    return f"{SESSION_PREFIX}{session_id[:8]}"


def start_tmux(session_id: str, cwd: str | None, create: bool = False) -> str:
    """Start (or find) the real interactive `claude` for this session inside a detached tmux session.
    Resuming keeps the session id and its full history, exactly like `claude --resume` in a terminal."""
    name = session_name(session_id)
    if subprocess.run(["tmux", "has-session", "-t", name], capture_output=True).returncode == 0:
        return name
    cmd = f"{shlex.quote(CLAUDE_BIN)} {'--session-id' if create else '--resume'} {shlex.quote(session_id)}"
    args = ["tmux", "new-session", "-d", "-s", name, "-x", "200", "-y", "50"]
    if cwd and os.path.isdir(cwd):
        args += ["-c", cwd]
    subprocess.run(args + [cmd], check=True, timeout=10)
    return name


def capture(target: str, history: int = 80) -> str:
    out = subprocess.run(["tmux", "capture-pane", "-p", "-t", target, "-S", f"-{history}"], capture_output=True, text=True, timeout=5)
    return out.stdout.rstrip()


async def launch(agent: dict, text: str | None, create: bool) -> str:
    """Start the agent's real CLI in tmux, wait until it is ready, then type `text`. Returns '' or an error."""
    sid = agent["id"]
    starting.add(sid)
    try:
        name = await asyncio.to_thread(start_tmux, sid, agent.get("cwd"), create)
        deadline = time.time() + 90
        while time.time() < deadline:
            reg = await asyncio.to_thread(discovery.live_entry, sid)
            if reg and reg.get("status") == "idle":
                break
            await asyncio.sleep(0.5)
        else:
            return ("The session did not become ready. It may be waiting for input (for example a folder-trust question): "
                    "open the Terminal tab and answer it, then send your message again.")
        if text:
            await asyncio.to_thread(send_tmux, name, text)
        return ""
    except subprocess.CalledProcessError as e:
        return f"Could not start the session in tmux: {e}"
    finally:
        starting.discard(sid)


def send_keys(pane: str, keys: list[str]) -> None:
    """Answer a dialog in a live terminal (Accept = Enter, Cancel = Escape, choose = number)."""
    bad = [k for k in keys if k not in TMUX_KEYS]
    if bad or not keys:
        raise ValueError(f"unsupported keys: {bad or keys}")
    subprocess.run(["tmux", "send-keys", "-t", pane, *keys], check=True, timeout=5)


def _clip(v, n=2000):
    return v if not isinstance(v, str) or len(v) <= n else v[:n] + "…"


def _payload(rid: str, req: dict) -> dict:
    tool = req.get("tool_name", "")
    inp = req.get("input") or {}
    return {
        "requestId": rid, "tool": tool, "description": req.get("description") or "",
        "reason": req.get("decision_reason") or "", "toolUseId": req.get("tool_use_id"),
        "input": inp if tool == "AskUserQuestion" else {k: _clip(v) for k, v in inp.items()},
        "canRemember": bool(req.get("permission_suggestions")),
    }


async def _write(run: Run, obj: dict) -> None:
    async with run.write_lock:
        if run.proc.stdin and not run.proc.stdin.is_closing():
            run.proc.stdin.write((json.dumps(obj) + "\n").encode())
            await run.proc.stdin.drain()


async def run_turn(agent: dict, text: str, *, fork: bool, create: bool, on_init, on_exit, on_change) -> None:
    """Run one turn headlessly. The turn is appended to the same transcript, so the dashboard (and a later
    terminal `claude --resume`) sees it. `fork` copies the history into a NEW session instead; it is used
    only when the session is open in a terminal, and only after the user confirmed."""
    args = [CLAUDE_BIN, "-p", "--session-id" if create else "--resume", agent["id"],
            "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
            "--permission-prompt-tool", "stdio", "--permission-mode", PERMISSION_MODE]
    if fork:
        args.append("--fork-session")
    cwd = agent.get("cwd") if agent.get("cwd") and os.path.isdir(agent["cwd"]) else None
    proc = await asyncio.create_subprocess_exec(
        *args, cwd=cwd, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        limit=16 * 1024 * 1024)
    run = Run(proc)
    key = agent["id"]
    runs[key] = run
    await _write(run, {"type": "user", "message": {"role": "user", "content": text}})

    async def handle_request(o: dict) -> None:
        rid, req = o.get("request_id"), o.get("request") or {}
        if req.get("subtype") != "can_use_tool":
            await _write(run, {"type": "control_response", "response": {"subtype": "error", "request_id": rid, "error": "unsupported"}})
            return
        fut = asyncio.get_running_loop().create_future()
        run.pending[rid] = {"future": fut, "payload": _payload(rid, req), "input": req.get("input") or {},
                            "suggestions": req.get("permission_suggestions") or []}
        await on_change()
        try:
            decision = await fut
        except asyncio.CancelledError:
            return
        finally:
            run.pending.pop(rid, None)
        await _write(run, {"type": "control_response", "response": {"subtype": "success", "request_id": rid, "response": decision}})
        await on_change()

    async def pump():
        fork_id, result, stderr = "", None, b""

        async def read_err():
            nonlocal stderr
            stderr = await proc.stderr.read()

        err_task = asyncio.create_task(read_err())
        async for line in proc.stdout:
            try:
                o = json.loads(line)
            except ValueError:
                continue
            t = o.get("type")
            if t == "system" and o.get("subtype") == "init":
                fork_id = o.get("session_id", "")
                if fork_id != key:
                    runs[fork_id] = run  # a fork is a new session; show it as working too
                await on_init(fork_id)
            elif t == "control_request":
                task = asyncio.create_task(handle_request(o))
                _tasks.add(task)
                task.add_done_callback(_tasks.discard)
            elif t == "result":
                result = o
                if run.proc.stdin and not run.proc.stdin.is_closing():
                    run.proc.stdin.close()  # turn finished: let the process exit
            elif t == "rate_limit_event":
                usage.update(o.get("rate_limit_info"))
        code = await proc.wait()
        await err_task
        for p in list(run.pending.values()):
            p["future"].cancel()
        runs.pop(key, None)
        if fork_id:
            runs.pop(fork_id, None)
        failed = code != 0 or (result and result.get("is_error"))
        err = ""
        if failed:
            err = (result or {}).get("result") or stderr.decode("utf-8", "replace").strip()[-400:] or f"claude exited with code {code}"
        await on_exit(err)

    t = asyncio.create_task(pump())
    _tasks.add(t)
    t.add_done_callback(_tasks.discard)


def resolve_permission(session_id: str, request_id: str, *, allow: bool, answers: dict | None, remember: bool) -> bool:
    run = runs.get(session_id)
    entry = run.pending.get(request_id) if run else None
    if not entry or entry["future"].done():
        return False
    if not allow:
        decision = {"behavior": "deny", "message": "Denied by the user in the dashboard."}
    else:
        inp = dict(entry["input"])
        if answers is not None:
            inp["answers"] = answers
        decision = {"behavior": "allow", "updatedInput": inp}
        if remember and entry["suggestions"]:
            decision["updatedPermissions"] = entry["suggestions"]
    entry["future"].set_result(decision)
    return True


def stop(session_id: str) -> bool:
    r = runs.get(session_id)
    if r:
        for p in list(r.pending.values()):
            p["future"].cancel()
        r.proc.send_signal(2)  # SIGINT
    return bool(r)
