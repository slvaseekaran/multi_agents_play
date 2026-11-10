#!/usr/bin/env bash
# Starts the backend. Used by the Windows app (via wsl.exe) and for manual runs.
cd "$(dirname "$(readlink -f "$0")")" || exit 1
exec .venv/bin/python -m app "$@"
