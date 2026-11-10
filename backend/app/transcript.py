"""Parses Claude Code session transcripts (JSONL) into a small chat-event model."""
import json
import os
import re
from pathlib import Path

HIDDEN_USER = re.compile(r"^<(local-command|command-name|command-message|command-args|system-reminder|agent-message|task-notification)")
PEER_IN = re.compile(r"<cross-session-message([^>]*)>\n?([\s\S]*?)\n?</cross-session-message>")
ARTIFACT_URL = re.compile(r"https://claude\.ai/(?:code/)?artifact/[A-Za-z0-9-]+")
# Bookkeeping records (api-request blobs, titles, ...) lead with their type; chat records don't.
BOOKKEEPING = re.compile(r'^\{"type":\s*"(?!user"|assistant")')
AI_TITLE = re.compile(r'"type":\s*"ai-title"[^\n]*?"aiTitle":\s*"((?:[^"\\]|\\.)*)"')
CWD = re.compile(r'"cwd":\s*"((?:[^"\\]|\\.)*)"')
MODEL = re.compile(r'"model":\s*"(claude-[^"]+)"')


def _clip(s: str, n: int) -> str:
    return s if len(s) <= n else s[:n] + "…"


def _summarize(inp) -> str:
    if not isinstance(inp, dict):
        return ""
    for k in ("command", "file_path", "pattern", "url", "description", "prompt", "query"):
        if inp.get(k):
            return _clip(" ".join(str(inp[k]).split()), 200)
    return _clip(json.dumps(inp), 200)


def _result_text(c) -> str:
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        return "".join((b.get("text") or "") for b in c if isinstance(b, dict))
    return ""


def parse_record(rec: dict) -> list[dict]:
    """One JSONL record -> zero or more events. Event ids are stable: '<uuid>:<n>'."""
    if not isinstance(rec, dict) or rec.get("isSidechain") or rec.get("isMeta"):
        return []
    msg = rec.get("message")
    rtype = rec.get("type")
    if not isinstance(msg, dict) or rtype not in ("user", "assistant"):
        return []
    out: list[dict] = []

    def push(**e):
        out.append({"id": f"{rec.get('uuid')}:{len(out)}", "ts": rec.get("timestamp"), **e})

    content = msg.get("content")
    blocks = [{"type": "text", "text": content}] if isinstance(content, str) else (content or [])
    for b in blocks:
        t = b.get("type")
        if t == "text" and (b.get("text") or "").strip():
            text = b["text"]
            if rtype == "user" and HIDDEN_USER.match(text.lstrip()):
                continue
            peer = PEER_IN.search(text) if rtype == "user" else None
            if peer:
                name = re.search(r'from-name="([^"]*)"', peer.group(1))
                push(role="peer", dir="in", peer=name.group(1) if name else "unknown", text=peer.group(2))
            else:
                push(role=rtype, text=text)
        elif t == "tool_use":
            inp = b.get("input") or {}
            if b.get("name") == "SendMessage":
                m = inp.get("message") or inp.get("content") or inp.get("summary") or ""
                if isinstance(m, str) and m.strip():
                    push(role="peer", dir="out", peer=str(inp.get("to") or ""), text=m, toolId=b.get("id"))
            else:
                ev = dict(role="tool", name=b.get("name"), text=_summarize(inp), toolId=b.get("id"))
                if b.get("name") in ("Write", "Artifact") and inp.get("file_path"):
                    ev["file"] = inp["file_path"]
                push(**ev)
        elif t == "tool_result":
            full = _result_text(b.get("content"))
            urls = list(dict.fromkeys(ARTIFACT_URL.findall(full)))
            ev = dict(role="result", forId=b.get("tool_use_id"), error=bool(b.get("is_error")), text=_clip(full, 400))
            if urls:
                ev["urls"] = urls
            push(**ev)
    return out


def parse_lines(text: str) -> list[dict]:
    events: list[dict] = []
    for line in text.split("\n"):
        if not line or BOOKKEEPING.match(line):
            continue
        try:
            events.extend(parse_record(json.loads(line)))
        except ValueError:
            pass  # partial or foreign line
    return events


def _read(path: str | Path, start: int, end: int) -> bytes:
    with open(path, "rb") as f:
        f.seek(start)
        return f.read(end - start)


def read_tail(path, max_bytes: int = 1_500_000) -> tuple[list[dict], int]:
    """Last `max_bytes` of the file, starting on a line boundary. Returns (events, file size)."""
    size = os.path.getsize(path)
    start = max(0, size - max_bytes)
    data = _read(path, start, size)
    if start > 0:
        data = data[data.find(b"\n") + 1:]
    return parse_lines(data.decode("utf-8", "replace")), size


def read_from(path, offset: int) -> tuple[list[dict], int]:
    """New complete lines since `offset` (bytes). Returns (events, new offset)."""
    size = os.path.getsize(path)
    if size < offset:
        return [], size
    if size == offset:
        return [], offset
    data = _read(path, offset, size)
    cut = data.rfind(b"\n")
    if cut < 0:
        return [], offset
    return parse_lines(data[:cut].decode("utf-8", "replace")), offset + cut + 1


def _ctx(u: dict) -> int:
    return (u.get("input_tokens") or 0) + (u.get("cache_read_input_tokens") or 0) + (u.get("cache_creation_input_tokens") or 0)


def _last_context(text: str) -> int:
    """Context size (tokens) of the latest assistant message in `text`."""
    for line in reversed(text.split("\n")):
        if '"usage"' in line and '"type":"assistant"' in line:
            try:
                u = (json.loads(line).get("message") or {}).get("usage") or {}
            except ValueError:
                continue
            if _ctx(u):
                return _ctx(u)
    return 0


def session_tokens(path) -> dict:
    """Token totals for a whole session (each API message counted once)."""
    per: dict = {}
    with open(path, "r", errors="replace") as f:
        for line in f:
            if '"usage"' not in line or '"type":"assistant"' not in line:
                continue
            try:
                d = json.loads(line)
            except ValueError:
                continue
            m = d.get("message") or {}
            if d.get("isSidechain") or not m.get("usage"):
                continue
            per[m.get("id") or d.get("uuid")] = m["usage"]
    us = list(per.values())
    return {
        "turns": len(us), "output": sum(u.get("output_tokens") or 0 for u in us),
        "fresh": sum((u.get("input_tokens") or 0) + (u.get("cache_creation_input_tokens") or 0) for u in us),
        "cacheRead": sum(u.get("cache_read_input_tokens") or 0 for u in us),
        "peak": max((_ctx(u) for u in us), default=0), "context": _ctx(us[-1]) if us else 0,
    }


def read_meta(path) -> dict:
    """Cheap card metadata: title, cwd, last chat line."""
    meta = {"title": "", "cwd": "", "last": "", "context": 0}
    size = os.path.getsize(path)
    head = _read(path, 0, min(size, 48000)).decode("utf-8", "replace")
    m = CWD.search(head)
    if m:
        try:
            meta["cwd"] = json.loads(f'"{m.group(1)}"')
        except ValueError:
            pass
    tail = _read(path, max(0, size - 200000), size).decode("utf-8", "replace")
    titles = AI_TITLE.findall(tail)
    if titles:
        try:
            meta["title"] = json.loads(f'"{titles[-1]}"')
        except ValueError:
            pass
    models = MODEL.findall(tail)
    meta["model"] = models[-1].removeprefix("claude-") if models else ""
    meta["context"] = _last_context(tail)
    chat = [e for e in parse_lines(tail[tail.find("\n") + 1:]) if e["role"] in ("user", "assistant")]
    if chat:
        meta["last"] = _clip(" ".join(chat[-1]["text"].split()), 140)
    return meta


def scan_artifacts(path) -> list[dict]:
    """Everything the agent produced: published Artifact URLs and files it wrote. Newest first."""
    events = parse_lines(Path(path).read_text("utf-8", "replace"))
    tools: dict[str, dict] = {}
    found: dict[str, dict] = {}
    for e in events:
        if e["role"] == "tool" and e.get("file"):
            tools[e["toolId"]] = e
        if e["role"] != "result" or e.get("error"):
            continue
        t = tools.get(e["forId"])
        if not t:
            continue
        if t["name"] == "Artifact":
            for url in e.get("urls", []):
                found[url] = {"kind": "artifact", "url": url, "name": os.path.basename(t["file"]) or url, "ts": e["ts"]}
        elif t["name"] == "Write":
            found[t["file"]] = {"kind": "file", "path": t["file"], "name": os.path.basename(t["file"]), "ts": e["ts"]}
    return sorted(found.values(), key=lambda i: i["ts"] or "", reverse=True)[:60]
