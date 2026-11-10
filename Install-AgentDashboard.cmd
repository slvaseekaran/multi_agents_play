@echo off
rem Double-click to build and install the desktop app. Pass -InstallPrerequisites to auto-install Rust/Build Tools.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-windows.ps1" %*
pause
