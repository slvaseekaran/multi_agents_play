"""Dashboard-owned persistent state. Never touches Claude's own files (except explicit delete)."""
import json
import threading

from .config import DATA_DIR

_FILE = DATA_DIR / "state.json"
_lock = threading.Lock()
_state: dict = {"names": {}, "created": {}, "usage": None, "teams": {}}
try:
    _state.update(json.loads(_FILE.read_text()))
except (OSError, ValueError):
    pass


def get() -> dict:
    return _state


def save() -> None:
    with _lock:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        tmp = _FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(_state, indent=1))
        tmp.replace(_FILE)
