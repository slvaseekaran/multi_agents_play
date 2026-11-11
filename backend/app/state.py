"""Dashboard-owned persistent state. Never touches Claude's own files (except explicit delete)."""
import json
import os
import threading

from .config import DATA_DIR

_FILE = DATA_DIR / "state.json"
_lock = threading.Lock()
_state: dict = {"names": {}, "created": {}, "usage": None, "teams": {}}
try:
    _state.update(json.loads(_FILE.read_text()))
except (OSError, ValueError):
    pass


# Migration: older versions kept the pre-/clear card and renamed it "<name> (before /clear)". Hide those cards.
_sup = _state.setdefault("superseded", [])
for _sid, _n in list(_state["names"].items()):
    if isinstance(_n, str) and _n.endswith(" (before /clear)"):
        if _sid not in _sup:
            _sup.append(_sid)
        del _state["names"][_sid]


def get() -> dict:
    return _state


def save() -> None:
    with _lock:
        DATA_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
        tmp = _FILE.with_suffix(".tmp")
        for _ in range(5):  # another thread may mutate the dict while it is serialised
            try:
                data = json.dumps(_state, indent=1)
                break
            except RuntimeError:
                continue
        else:
            return
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(data)
        tmp.replace(_FILE)
