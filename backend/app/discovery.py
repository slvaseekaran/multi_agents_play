"""Finds Claude Code sessions: live ones from the CLI's own session registry
(~/.claude/sessions/<pid>.json), past ones from transcript files."""
import json
import os
import shutil
import shutil as _sh
import subprocess
import time
from pathlib import Path

from . import state
from .config import HOMES, LOCAL_HOME, OFFLINE_DAYS, OFFLINE_MAX
from .transcript import read_meta

STATUS = {"busy": "working", "shell": "working", "idle": "idle", "waiting": "waiting"}


def _stat(p):
    try:
        return os.stat(p)
    except OSError:
        return None


def _proc_fields(pid: int):
    try:
        return Path(f"/proc/{pid}/stat").read_text().rsplit(") ", 1)[1].split(" ")
    except (OSError, IndexError):
        return None


def _is_alive(reg: dict) -> bool:
    f = _proc_fields(reg["pid"])
    if not f:
        return False
    return not reg.get("procStart") or str(reg["procStart"]) == f[19]  # guards against pid reuse


def _tty(pid: int) -> str:
    try:
        return os.readlink(f"/proc/{pid}/fd/0").removeprefix("/dev/")
    except OSError:
        return ""


def _ppid(pid: int) -> int:
    f = _proc_fields(pid)
    return int(f[1]) if f else 0


_panes = {"at": 0.0, "map": {}}


def _tmux_panes() -> dict:
    if time.time() - _panes["at"] < 2 or not shutil.which("tmux"):
        return _panes["map"]
    m = {}
    try:
        out = subprocess.run(["tmux", "list-panes", "-a", "-F", "#{pane_pid} #{pane_id}"], capture_output=True, text=True, timeout=2).stdout
        for line in out.strip().splitlines():
            pid, _, pane = line.partition(" ")
            if pane:
                m[int(pid)] = pane
    except (OSError, subprocess.SubprocessError, ValueError):
        pass
    _panes.update(at=time.time(), map=m)
    return m


def _tmux_pane_for(pid: int) -> str:
    panes = _tmux_panes()
    p = pid
    for _ in range(12):
        if p <= 1 or not p:
            break
        if p in panes:
            return panes[p]
        p = _ppid(p)
    return ""


_file_cache: dict[str, str] = {}


def transcript_path(session_id: str) -> str | None:
    hit = _file_cache.get(session_id)
    if hit and _stat(hit):
        return hit
    for home in HOMES:
        root = home / "projects"
        try:
            dirs = os.listdir(root)
        except OSError:
            continue
        for d in dirs:
            f = root / d / f"{session_id}.jsonl"
            if _stat(f):
                _file_cache[session_id] = str(f)
                return str(f)
    return None


_meta_cache: dict[str, tuple[float, dict]] = {}


def _meta(path: str, st) -> dict:
    c = _meta_cache.get(path)
    if c and c[0] == st.st_mtime:
        return c[1]
    try:
        meta = read_meta(path)
    except OSError:
        meta = {"title": "", "cwd": "", "last": "", "model": ""}
    _meta_cache[path] = (st.st_mtime, meta)
    return meta


_offline = {"at": 0.0, "list": []}


def _offline_sessions(live_ids: set, extra_ids: set) -> list:
    if time.time() - _offline["at"] > 5:
        found, cutoff = [], time.time() - OFFLINE_DAYS * 86400
        for home in HOMES:
            root = home / "projects"
            try:
                dirs = os.listdir(root)
            except OSError:
                continue
            for d in dirs:
                try:
                    files = os.listdir(root / d)
                except OSError:
                    continue
                for f in files:
                    if not f.endswith(".jsonl"):
                        continue
                    p = str(root / d / f)
                    st = _stat(p)
                    if st and st.st_mtime > cutoff:
                        found.append((f[:-6], p, st, home))
        found.sort(key=lambda x: x[2].st_mtime, reverse=True)
        _offline.update(at=time.time(), list=found)
    rest = [o for o in _offline["list"] if o[0] not in live_ids]
    return rest[:OFFLINE_MAX]


def _offline_agent(sid, path, st, home) -> dict:
    meta = _meta(path, st)
    return {
        "id": sid, "name": meta["title"] or sid[:8], "title": "", "cwd": meta["cwd"], "status": "offline", "waitingFor": "",
        "pid": 0, "tty": "", "tmuxPane": "", "control": "managed" if home == LOCAL_HOME else "readonly",
        "last": meta["last"], "model": meta.get("model", ""), "context": meta.get("context", 0), "lastActivity": st.st_mtime * 1000, "file": path,
    }


def discover() -> list[dict]:
    agents: list[dict] = []
    live_ids: set = set()
    sess_dir = LOCAL_HOME / "sessions"
    try:
        names = [n for n in os.listdir(sess_dir) if n.endswith(".json") and n[:-5].isdigit()]
    except OSError:
        names = []
    for n in names:
        try:
            reg = json.loads((sess_dir / n).read_text())
        except (OSError, ValueError):
            continue
        if not reg.get("sessionId") or reg.get("kind") not in ("interactive", "bg") or not _is_alive(reg):
            continue
        path = transcript_path(reg["sessionId"])
        st = _stat(path) if path else None
        meta = _meta(path, st) if st else {"title": "", "cwd": "", "last": "", "model": ""}
        pane = _tmux_pane_for(reg["pid"])
        live_ids.add(reg["sessionId"])
        agents.append({
            "id": reg["sessionId"], "name": reg.get("name") or reg["sessionId"][:8], "title": meta["title"],
            "cwd": reg.get("cwd") or meta["cwd"], "status": STATUS.get(reg.get("status"), "working"),
            "waitingFor": reg.get("waitingFor") or "", "pid": reg["pid"], "tty": _tty(reg["pid"]), "tmuxPane": pane,
            "control": "tmux" if pane else "fork", "last": meta["last"], "model": meta.get("model", ""), "context": meta.get("context", 0),
            "lastActivity": st.st_mtime * 1000 if st else reg.get("updatedAt"), "file": path,
        })
    created = state.get()["created"]
    for sid, p, st, home in _offline_sessions(live_ids, set(created)):
        agents.append(_offline_agent(sid, p, st, home))
    # Dashboard-created agents always show, even before their first transcript line exists.
    have = {a["id"] for a in agents}
    for sid, c in created.items():
        if sid in have:
            continue
        path = transcript_path(sid)
        st = _stat(path) if path else None
        if st:
            a = _offline_agent(sid, path, st, LOCAL_HOME)
        else:
            a = {"id": sid, "name": c["name"], "title": "", "cwd": c["cwd"], "status": "offline", "waitingFor": "", "pid": 0,
                 "tty": "", "tmuxPane": "", "control": "managed", "last": "New agent: send a first prompt", "model": "",
                 "lastActivity": c.get("createdAt"), "file": None, "isNew": True}
        agents.append(a)
    aliases = state.get()["names"]
    for a in agents:
        a["origName"] = a["name"]
        if aliases.get(a["id"]):
            a["name"] = aliases[a["id"]]
    return agents


def live_entry(session_id: str) -> dict | None:
    """Registry entry of a live `claude` process currently on this session, if any."""
    sess_dir = LOCAL_HOME / "sessions"
    try:
        names = [n for n in os.listdir(sess_dir) if n.endswith(".json") and n[:-5].isdigit()]
    except OSError:
        return None
    for n in names:
        try:
            reg = json.loads((sess_dir / n).read_text())
        except (OSError, ValueError):
            continue
        if reg.get("sessionId") == session_id and _is_alive(reg):
            return reg
    return None


def terminate(pid: int) -> bool:
    """Politely close an idle Claude CLI process (SIGTERM). Refuses anything that is not a claude process."""
    import signal
    try:
        cmd = Path(f"/proc/{pid}/cmdline").read_bytes().replace(b"\0", b" ").decode("utf-8", "replace")
    except OSError:
        return True  # already gone
    if "claude" not in cmd:
        return False
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        return True
    for _ in range(50):
        if not _proc_fields(pid):
            return True
        time.sleep(0.1)
    return False


def forget(session_id: str) -> None:
    """Delete an offline session's transcript and per-session folder. Caller verifies it is not in use."""
    path = transcript_path(session_id)
    if path:
        Path(path).unlink(missing_ok=True)
        _sh.rmtree(Path(path).parent / session_id, ignore_errors=True)
        _meta_cache.pop(path, None)
    _file_cache.pop(session_id, None)
    _offline["at"] = 0
    st = state.get()
    st["names"].pop(session_id, None)
    st["created"].pop(session_id, None)
    state.save()
