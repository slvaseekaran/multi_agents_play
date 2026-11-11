"""Agent dashboard backend (FastAPI). Local-only: manages Claude Code CLI sessions inside WSL."""
import asyncio
import json
import os
import re
import subprocess
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlparse

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import control, discovery, state, transcript, usage
from .config import CONTEXT_WINDOW, ALLOWED_HOSTS, ALLOWED_ORIGINS, DATA_DIR, PEER_WINDOW_S, PERMISSION_MODE, UI_DIST

import time

BG_DIR = DATA_DIR / "bg"
BG_RE = re.compile(r"^continental-gt-650-rocker-red\.(jpg|png|webp)$")
ID_RE = r"[0-9a-f-]{36}"

agents: list[dict] = []
agents_json = ""
offsets: dict[str, int] = {}
pid_session: dict[int, str] = {}
status_prev: dict[str, str] = {}
_tok_cache: dict[str, tuple] = {}
peer_log: dict[str, dict[str, float]] = {}
clients: set[asyncio.Queue] = set()
_tick_lock = asyncio.Lock()


def emit(type_: str, **data) -> None:
    msg = f"data: {json.dumps({'type': type_, **data})}\n\n"
    for q in list(clients):
        try:
            q.put_nowait(msg)
        except asyncio.QueueFull:  # a stalled browser tab must not grow memory without bound
            clients.discard(q)


def _iso_seconds(ts) -> float:
    try:
        from datetime import datetime
        return datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()
    except (AttributeError, ValueError):
        return time.time()


def note_peers(sid: str, events: list[dict]) -> None:
    for e in events:
        if e["role"] == "peer" and e.get("peer"):
            peer_log.setdefault(sid, {})[e["peer"]] = _iso_seconds(e.get("ts"))


def _resolve(name: str) -> str:
    for a in agents:
        if name in (a["origName"], a["name"], a["id"]):
            return a["name"]
    return name


def view(a: dict) -> dict:
    running = control.is_running(a["id"])
    launching = a["id"] in control.starting
    peers = [_resolve(n) for n, t in peer_log.get(a["id"], {}).items() if time.time() - t < PEER_WINDOW_S]
    out = {k: v for k, v in a.items() if k != "file"}
    perms = control.permissions_for(a["id"])
    status = "waiting" if perms else ("working" if (running or launching) else a["status"])
    # A dashboard-run turn plus a live terminal process on the SAME session means two writers on one history.
    out.update(status=status, managedRun=running, peers=peers, permissions=perms, conflict=bool((running and a.get("pid")) or a.get("duplicates")))
    if perms:
        out["waitingFor"] = f"permission: {perms[0]['tool']}"
    return out


def _scan() -> tuple[list[dict], list[tuple[str, list[dict]]]]:
    """Blocking part of a tick: discover sessions and read new transcript lines."""
    found = discovery.discover()
    new_events = []
    for a in found:
        if not a.get("file") or (a["status"] == "offline" and not control.is_running(a["id"])):
            continue
        try:
            if a["id"] not in offsets:  # first sight: remember where we are, seed peer links from recent history
                events, size = transcript.read_tail(a["file"])
                note_peers(a["id"], events)
                offsets[a["id"]] = size
                continue
            events, offsets[a["id"]] = transcript.read_from(a["file"], offsets[a["id"]])
            if events:
                note_peers(a["id"], events)
                new_events.append((a["id"], events))
        except OSError:
            pass
    return found, new_events


async def tick() -> None:
    global agents, agents_json
    async with _tick_lock:
        found, new_events = await asyncio.to_thread(_scan)
        known = {x["id"] for x in agents}
        agents = found
        for a in found:  # same process, new session id (e.g. after /clear): carry the name over and tell the UI
            pid = a.get("pid")
            if not pid:
                continue
            old = pid_session.get(pid)
            if old and old != a["id"]:
                names = state.get()["names"]
                if old in names and a["id"] not in names:
                    names[a["id"]] = names[old]
                if a["id"] not in known:  # brand-new id in the same process = /clear (a /resume target is already known)
                    names.pop(old, None)
                    sup = state.get().setdefault("superseded", [])
                    if old not in sup:
                        sup.append(old)  # hide the pre-/clear card: same conversation
                    state.save()
                emit("fork", **{"from": old, "to": a["id"]})
            pid_session[pid] = a["id"]
        for sid, events in new_events:
            emit("messages", id=sid, events=events)
        views = [view(a) for a in agents]
        for v in views:  # an agent just finished work: plan usage changed, refresh it soon
            if status_prev.get(v["id"]) == "working" and v["status"] != "working":
                usage.request_refresh()
            status_prev[v["id"]] = v["status"]
        snapshot = json.dumps(views)
        if snapshot != agents_json:
            agents_json = snapshot
            emit("agents", agents=json.loads(snapshot))


async def tick_loop() -> None:
    while True:
        try:
            await tick()
        except Exception as e:  # keep the loop alive
            print("tick error:", repr(e), flush=True)
        await asyncio.sleep(1)


@asynccontextmanager
async def lifespan(_app):
    tasks = [asyncio.create_task(tick_loop()), asyncio.create_task(usage.run(lambda u: emit("usage", usage=u)))]
    yield
    for t in tasks:
        t.cancel()


app = FastAPI(title="Agent Dashboard", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=ALLOWED_ORIGINS, allow_methods=["GET", "POST"], allow_headers=["Content-Type"])


@app.middleware("http")
async def local_only(request: Request, call_next):
    """Reject foreign Host headers (DNS rebinding) and cross-site mutations (CSRF)."""
    host = (request.headers.get("host") or "").rsplit(":", 1)[0] if not request.headers.get("host", "").startswith("[") \
        else request.headers["host"].split("]")[0] + "]"
    if host not in ALLOWED_HOSTS:
        return JSONResponse({"error": "forbidden host"}, status_code=403)
    origin = request.headers.get("origin")
    if origin and origin not in ALLOWED_ORIGINS:  # a foreign page (the app's own webview is allow-listed)
        return JSONResponse({"error": "forbidden origin"}, status_code=403)
    if request.method not in ("GET", "HEAD", "OPTIONS"):
        origin = request.headers.get("origin")
        if origin not in ALLOWED_ORIGINS:
            return JSONResponse({"error": "forbidden origin"}, status_code=403)
    m = re.match(r"^/api/agents/([^/]+)/", request.url.path)
    if m and not discovery.SID_RE.match(m.group(1)):
        return JSONResponse({"error": "bad session id"}, status_code=400)
    resp = await call_next(request)
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    resp.headers.setdefault("X-Frame-Options", "DENY")
    resp.headers.setdefault("Referrer-Policy", "no-referrer")
    return resp


def err(msg: str, code: int = 400, **extra):
    return JSONResponse({"error": msg, **extra}, status_code=code)


def win_path(p: str) -> str:
    m = re.match(r"^/mnt/([a-z])/(.*)$", p)
    if m:
        return f"{m.group(1).upper()}:\\{m.group(2).replace('/', chr(92))}"
    return f"\\\\wsl.localhost\\{os.environ.get('WSL_DISTRO_NAME', 'Ubuntu')}{p.replace('/', chr(92))}"


def _agent(sid: str) -> dict | None:
    return next((a for a in agents if a["id"] == sid), None)


@app.get("/api/health")
async def health():
    return {"app": "agent-dashboard", "ok": True, "permissionMode": PERMISSION_MODE}


@app.get("/api/agents")
async def list_agents():
    return {"agents": json.loads(agents_json or "[]"), "usage": usage.current}


@app.get("/api/events")
async def events(request: Request):
    q: asyncio.Queue = asyncio.Queue(maxsize=2000)
    q.put_nowait(f"data: {json.dumps({'type': 'agents', 'agents': json.loads(agents_json or '[]')})}\n\n")
    q.put_nowait(f"data: {json.dumps({'type': 'usage', 'usage': usage.current})}\n\n")
    q.put_nowait(f"data: {json.dumps({'type': 'teams', 'teams': team_list()})}\n\n")
    clients.add(q)

    async def gen():
        try:
            while True:
                try:
                    yield await asyncio.wait_for(q.get(), 20)
                except asyncio.TimeoutError:
                    yield ": ping\n\n"
        finally:
            clients.discard(q)

    return StreamingResponse(gen(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.get(f"/api/agents/{{sid}}/messages")
async def messages(sid: str, limit: int = 300):
    limit = max(1, min(limit, 2000))
    a = _agent(sid)
    path = a["file"] if a else discovery.transcript_path(sid)
    if not path:
        return {"events": []}
    evs, _ = await asyncio.to_thread(transcript.read_tail, path)
    return {"events": evs[-limit:]}


@app.get(f"/api/agents/{{sid}}/artifacts")
async def artifacts(sid: str):
    a = _agent(sid)
    path = a["file"] if a else discovery.transcript_path(sid)
    if not path:
        return {"items": []}
    items = await asyncio.to_thread(transcript.scan_artifacts, path)
    return {"items": [{**i, "winPath": win_path(i["path"])} if i["kind"] == "file" else i for i in items]}


class SendBody(BaseModel):
    text: str = ""
    fork: bool = False
    images: list[str] = []


@app.post("/api/agents/{sid}/send")
async def send(sid: str, body: SendBody):
    a = _agent(sid)
    if not a:
        return err("Unknown agent", 404)
    imgs = _upload_paths(body.images)
    if imgs is None:
        return err("Unknown attachment")
    if not body.text.strip() and not imgs:
        return err("Empty prompt")
    if control.is_running(sid) or sid in control.starting:
        return err("This agent is still busy", 409)
    if a["control"] == "readonly":
        return err("Sessions from another Claude home are history-only")
    if a["control"] == "tmux":
        # Same as typing in the terminal: slash commands, queued messages and dialog answers all work.
        try:
            await asyncio.to_thread(control.send_tmux, a["tmuxPane"], body.text, imgs)
        except Exception as e:
            return err(str(e), 500)
        return {"via": "tmux"}
    if a["control"] == "managed" and control.tmux_ok():
        # Offline session: start the real CLI (`claude --resume`) in tmux and type the message once it is ready.
        async def go():
            msg = await control.launch(a, body.text, create=bool(a.get("isNew")), images=imgs)
            if msg:
                emit("note", id=sid, level="error", text=msg)
            await tick()
        t = asyncio.create_task(go()); control._tasks.add(t); t.add_done_callback(control._tasks.discard)
        await tick()
        return {"via": "tmux-start"}
    if a["control"] == "fork" and control.tmux_ok() and a.get("pid") and not a.get("duplicates"):
        # Keep ONE conversation: move the idle terminal session into tmux (same session id, same history), then send.
        if a["status"] != "idle":
            return err(f"This session is {a['status']} in its terminal; send again when it is idle", 409)
        if not await asyncio.to_thread(discovery.terminate, a["pid"]):
            return err("Could not close the terminal's Claude process", 409)

        async def move_and_send():
            msg = await control.launch(a, body.text, create=False, images=imgs)
            if msg:
                emit("note", id=sid, level="error", text=msg)
            await tick()
        t = asyncio.create_task(move_and_send()); control._tasks.add(t); t.add_done_callback(control._tasks.discard)
        await tick()
        return {"via": "tmux-start"}
    # A session open in a plain terminal is never written to in place (two writers would corrupt its history):
    # the user either moves it into the dashboard ("adopt") or forks a copy.
    if a["control"] == "fork" and not body.fork:
        return err("This session is open in a terminal outside tmux, so it cannot be typed into.", 409, needsFork=True)
    do_fork = a["control"] == "fork"

    async def on_init(new_id: str):
        if do_fork:
            emit("fork", **{"from": sid, "to": new_id})
        await tick()

    async def on_exit(error: str):
        if error:
            emit("note", id=sid, level="error", text=error)
        await tick()

    control.starting.add(sid)  # reserve: two quick sends must not spawn two writers on one session
    try:
        await control.run_turn(a, body.text + "".join(f"\n[image: {p}]" for p in imgs), fork=do_fork, create=bool(a.get("isNew")), on_init=on_init, on_exit=on_exit, on_change=tick)
    finally:
        control.starting.discard(sid)
    await tick()
    return {"via": "fork" if do_fork else "managed"}


UPLOAD_DIR = DATA_DIR / "uploads"
_IMG_MAGIC = ((b"\xff\xd8\xff", "jpg"), (b"\x89PNG\r\n\x1a\n", "png"), (b"GIF8", "gif"))


def _upload_paths(names: list[str]) -> list[str] | None:
    """Attachments are only ever files this backend saved itself (no arbitrary paths from the client)."""
    out = []
    for n in names:
        p = (UPLOAD_DIR / os.path.basename(n)).resolve()
        if p.parent != UPLOAD_DIR.resolve() or not p.is_file():
            return None
        out.append(str(p))
    return out


@app.post("/api/uploads")
async def upload(request: Request):
    """Save a pasted/dropped image so it can be attached to a message. Returns the stored file name."""
    if int(request.headers.get("content-length") or 0) > 25_000_000:
        return err("Image too large (25 MB max)", 413)
    buf = b""
    async for chunk in request.stream():
        buf += chunk
        if len(buf) > 25_000_000:
            return err("Image too large (25 MB max)", 413)
    ext = next((e for m, e in _IMG_MAGIC if buf.startswith(m)), None) or ("webp" if buf[:4] == b"RIFF" and buf[8:12] == b"WEBP" else None)
    if not ext:
        return err("Use a PNG, JPEG, GIF or WebP image")
    UPLOAD_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    cutoff = time.time() - 7 * 86400  # keep uploads a week; old ones are swept on the next upload
    for f in UPLOAD_DIR.iterdir():
        try:
            if f.stat().st_mtime < cutoff:
                f.unlink(missing_ok=True)
        except OSError:
            pass
    name = f"{uuid.uuid4().hex}.{ext}"
    fd = os.open(UPLOAD_DIR / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as fh:
        fh.write(buf)
    return {"name": name}


@app.post("/api/agents/{sid}/dedupe")
async def dedupe(sid: str):
    """The session is open in several processes: close the extra ones (only if idle) and keep the card's own."""
    a = _agent(sid)
    if not a or not a.get("duplicates"):
        return err("Nothing to close", 404)
    if a["status"] not in ("idle", "offline") or any(d["status"] != "idle" for d in a["duplicates"]):
        return err("Wait until every copy of this session is idle", 409)
    closed = 0
    for d in a["duplicates"]:
        if await asyncio.to_thread(discovery.terminate, d["pid"]):
            closed += 1
    await tick()
    return {"closed": closed}


@app.post("/api/agents/{sid}/start")
async def start(sid: str):
    """Open the agent's real Claude Code session (resume in tmux) without sending anything."""
    a = _agent(sid)
    if not a:
        return err("Unknown agent", 404)
    if a["control"] != "managed" or not control.tmux_ok():
        return err("This agent cannot be started from here")

    async def go():
        msg = await control.launch(a, None, create=bool(a.get("isNew")))
        if msg:
            emit("note", id=sid, level="error", text=msg)
        await tick()
    t = asyncio.create_task(go()); control._tasks.add(t); t.add_done_callback(control._tasks.discard)
    await tick()
    return {"ok": True}


@app.post("/api/agents/{sid}/adopt")
async def adopt(sid: str):
    """Move a session that is open in a plain terminal into the dashboard: close that terminal's claude
    (idle only) and resume the SAME session in tmux. Explicitly requested by the user; history is untouched."""
    a = _agent(sid)
    if not a:
        return err("Unknown agent", 404)
    if a["control"] != "fork" or a["status"] != "idle" or not a.get("pid"):
        return err("Only an idle session open in a plain terminal can be moved", 409)
    if not control.tmux_ok():
        return err("tmux is not installed in WSL", 409)
    if not await asyncio.to_thread(discovery.terminate, a["pid"]):
        return err("Could not close the terminal's Claude process", 409)

    async def go():
        msg = await control.launch(a, None, create=False)
        if msg:
            emit("note", id=sid, level="error", text=msg)
        await tick()
    t = asyncio.create_task(go()); control._tasks.add(t); t.add_done_callback(control._tasks.discard)
    await tick()
    return {"ok": True}


@app.get("/api/agents/{sid}/screen")
async def screen(sid: str):
    """What the real terminal shows right now (permission dialogs, slash-command output, ...)."""
    a = _agent(sid)
    if not a or a["control"] != "tmux":
        return {"text": "", "live": False}
    try:
        return {"text": await asyncio.to_thread(control.capture, a["tmuxPane"]), "live": True}
    except Exception:
        return {"text": "", "live": False}


class PermissionBody(BaseModel):
    requestId: str
    allow: bool
    answers: dict | None = None
    remember: bool = False


@app.post("/api/agents/{sid}/permission")
async def permission(sid: str, body: PermissionBody):
    """Answer an approval request or a question from a dashboard-run agent."""
    if not control.resolve_permission(sid, body.requestId, allow=body.allow, answers=body.answers, remember=body.remember):
        return err("This request is no longer pending", 409)
    await asyncio.sleep(0.05)
    await tick()
    return {"ok": True}


class KeysBody(BaseModel):
    keys: list[str]


@app.post("/api/agents/{sid}/keys")
async def keys(sid: str, body: KeysBody):
    """Press keys in a live tmux session, e.g. Enter to accept a dialog or Escape to cancel it."""
    a = _agent(sid)
    if not a or a["control"] != "tmux":
        return err("Only sessions running in tmux can receive key presses", 400)
    try:
        await asyncio.to_thread(control.send_keys, a["tmuxPane"], body.keys)
    except (ValueError, subprocess.SubprocessError) as e:
        return err(str(e))
    return {"ok": True}


@app.post("/api/agents/{sid}/stop")
async def stop(sid: str):
    a = _agent(sid)
    if a and a["control"] == "tmux":  # same as pressing Esc to interrupt in the CLI
        try:
            await asyncio.to_thread(control.send_keys, a["tmuxPane"], ["Escape"])
        except (ValueError, subprocess.SubprocessError) as e:
            return err(str(e), 500)
        return {"stopped": True}
    return {"stopped": control.stop(sid)}


class RenameBody(BaseModel):
    name: str = ""


@app.post("/api/agents/{sid}/rename")
async def rename(sid: str, body: RenameBody):
    if not _agent(sid):
        return err("Unknown agent", 404)
    clean = body.name.strip()[:60]
    if clean:
        state.get()["names"][sid] = clean
    else:
        state.get()["names"].pop(sid, None)
    state.save()
    await tick()
    return {"ok": True}


@app.post("/api/agents/{sid}/delete")
async def delete(sid: str):
    a = _agent(sid)
    if not a:
        return err("Unknown agent", 404)
    if a["status"] not in ("offline", "idle") or control.is_running(sid) or sid in control.starting:
        return err(f"Agent is {a['status']}; wait until it is idle or offline", 409)
    if a["control"] == "readonly":
        return err("History-only sessions cannot be deleted from here")
    if a["status"] == "idle":  # live but idle terminal session: close it first, then delete its history
        if not await asyncio.to_thread(discovery.terminate, a["pid"]):
            return err("Could not close the idle terminal session; close it manually, then delete", 409)
        await asyncio.sleep(0.5)
    await asyncio.to_thread(discovery.forget, sid)
    offsets.pop(sid, None)
    peer_log.pop(sid, None)
    await tick()
    return {"ok": True}


# ---- teams: named groups of agents shown together in an isolated room
def team_list() -> list[dict]:
    return [{"id": tid, **t} for tid, t in state.get().get("teams", {}).items()]


class TeamBody(BaseModel):
    name: str
    members: list[dict]


def _save_team(tid: str | None, body: TeamBody):
    name = body.name.strip()[:60]
    members = [{"id": str(m.get("id", "")), "name": str(m.get("name", ""))[:80]} for m in body.members if m.get("id")][:12]
    if not name or len(members) < 2:
        return err("A team needs a name and at least two agents")
    teams = state.get().setdefault("teams", {})
    if tid is not None and tid not in teams:
        return err("Unknown team", 404)
    teams[tid or str(uuid.uuid4())] = {"name": name, "members": members}
    state.save()
    emit("teams", teams=team_list())
    return {"ok": True}


@app.post("/api/teams")
async def team_create(body: TeamBody):
    return _save_team(None, body)


@app.post("/api/teams/{tid}/update")
async def team_update(tid: str, body: TeamBody):
    return _save_team(tid, body)


@app.post("/api/teams/{tid}/delete")
async def team_delete(tid: str):
    state.get().setdefault("teams", {}).pop(tid, None)
    state.save()
    emit("teams", teams=team_list())
    return {"ok": True}


class CreateBody(BaseModel):
    name: str
    cwd: str


@app.post("/api/agents")
async def create(body: CreateBody):
    name = body.name.strip()[:60]
    if not name:
        return err("Name is required")
    if not os.path.isabs(body.cwd) or not os.path.isdir(body.cwd):
        return err("Working directory must be an existing absolute path (WSL path)")
    sid = str(uuid.uuid4())
    state.get()["created"][sid] = {"name": name, "cwd": body.cwd, "createdAt": int(time.time() * 1000)}
    state.get()["names"][sid] = name
    state.save()
    await tick()
    return {"id": sid}


def _tokens_for(path: str) -> dict:
    st = os.stat(path)
    key = (st.st_mtime, st.st_size)
    hit = _tok_cache.get(path)
    if hit and hit[0] == key:
        return hit[1]
    res = transcript.session_tokens(path)
    _tok_cache[path] = (key, res)
    return res


@app.get("/api/usage/agents")
async def usage_agents():
    """Per-agent token usage (computed from transcripts; cached until a transcript changes)."""
    rows = []
    for a in sorted((x for x in agents if x.get("file")), key=lambda x: x.get("lastActivity") or 0, reverse=True)[:25]:
        try:
            t = await asyncio.to_thread(_tokens_for, a["file"])
        except OSError:
            continue
        rows.append({"id": a["id"], "name": a["name"], "model": a.get("model", ""), "status": a["status"], **t})
    return {"rows": rows, "contextWindow": CONTEXT_WINDOW}


@app.post("/api/usage/refresh")
async def usage_refresh():
    await usage.ping()
    return {"usage": usage.current}


def _bg_file() -> str | None:
    try:
        return next((f for f in os.listdir(BG_DIR) if BG_RE.match(f)), None)
    except OSError:
        return None


@app.get("/api/background")
async def get_background():
    return {"file": _bg_file()}


@app.post("/api/background")
async def set_background(request: Request):
    if int(request.headers.get("content-length") or 0) > 40_000_000:
        return err("Image too large (40 MB max)", 413)
    buf = b""
    async for chunk in request.stream():
        buf += chunk
        if len(buf) > 40_000_000:
            return err("Image too large (40 MB max)", 413)
    ext = "jpg" if buf[:3] == b"\xff\xd8\xff" else "png" if buf[:4] == b"\x89PNG" else \
        "webp" if buf[:4] == b"RIFF" and buf[8:12] == b"WEBP" else None
    if not ext:
        return err("Use a JPEG, PNG or WebP image")
    BG_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    for f in BG_DIR.iterdir():
        if f.name.startswith("continental-gt-650-rocker-red."):
            f.unlink()
    (BG_DIR / f"continental-gt-650-rocker-red.{ext}").write_bytes(buf)
    return {"file": _bg_file()}


@app.get("/bg/{name}")
async def bg(name: str):
    if not BG_RE.match(name) or not (BG_DIR / name).is_file():
        return JSONResponse({"error": "not found"}, status_code=404)
    return FileResponse(BG_DIR / name, headers={"Cache-Control": "no-cache"})


# Optional: also serve the built UI so the dashboard works in a plain browser (http://localhost:PORT).
if UI_DIST.is_dir():
    app.mount("/", StaticFiles(directory=UI_DIST, html=True), name="ui")
