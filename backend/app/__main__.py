"""Entry point: python -m app [--watch-stdin]

--watch-stdin: exit when stdin reaches EOF. The Windows (Tauri) host keeps a pipe open to this process, so the
backend can never outlive the app, even if the app is killed.
"""
import os
import sys
import threading

import uvicorn

from .config import PORT


def _watch_stdin() -> None:
    try:
        sys.stdin.buffer.read()  # blocks until the parent closes the pipe
    finally:
        os._exit(0)


if __name__ == "__main__":
    if "--watch-stdin" in sys.argv:
        threading.Thread(target=_watch_stdin, daemon=True).start()
    uvicorn.run("app.main:app", host="127.0.0.1", port=PORT, log_level="warning")
