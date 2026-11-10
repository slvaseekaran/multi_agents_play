// Hide the console window in release builds on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Desktop shell. It does three things only:
//!   1. start the FastAPI backend inside WSL2 (hidden, via `wsl.exe`), unless one is already listening;
//!   2. tell the UI where the backend is (`backend_info`);
//!   3. stop the backend when the window closes.
//!
//! Lifetime safety: the backend is started with `--watch-stdin` and we keep the write end of its stdin
//! pipe. When this process exits, crashes, or is killed, the pipe closes, the backend sees EOF and exits.

use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{Manager, RunEvent, State};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// `%APPDATA%\AgentDashboard\config.json`, written by scripts\install-windows.ps1.
#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct Config {
    /// WSL distribution name; empty means the default distribution.
    distro: String,
    /// Linux path of the `backend` folder, e.g. /home/me/project/backend.
    backend_dir: String,
    port: u16,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct BackendInfo {
    url: String,
    log_path: String,
    error: Option<String>,
}

struct AppState {
    child: Mutex<Option<Child>>,
    info: BackendInfo,
}

fn env_dir(var: &str) -> PathBuf {
    PathBuf::from(std::env::var(var).unwrap_or_else(|_| ".".into())).join("AgentDashboard")
}

fn load_config() -> Result<Config, String> {
    let path = env_dir("APPDATA").join("config.json");
    let text = fs::read_to_string(&path)
        .map_err(|_| format!("Missing {}. Run scripts\\install-windows.ps1 first.", path.display()))?;
    let mut cfg: Config = serde_json::from_str(&text).map_err(|e| format!("Bad config.json: {e}"))?;
    if cfg.port == 0 {
        cfg.port = 7777;
    }
    if cfg.backend_dir.is_empty() || cfg.backend_dir.contains('\'') {
        return Err("config.json: backendDir is missing or contains a quote".into());
    }
    Ok(cfg)
}

fn port_open(port: u16) -> bool {
    TcpStream::connect_timeout(&SocketAddr::from(([127, 0, 0, 1], port)), Duration::from_millis(300)).is_ok()
}

fn spawn_backend(cfg: &Config, log: &PathBuf) -> Result<Child, String> {
    let log_file = File::create(log).map_err(|e| format!("Cannot create {}: {e}", log.display()))?;
    let log_err = log_file.try_clone().map_err(|e| e.to_string())?;

    let mut cmd = Command::new("wsl.exe");
    if !cfg.distro.is_empty() {
        cmd.args(["-d", &cfg.distro]);
    }
    // Login shell so PATH (e.g. ~/.local/bin/claude) matches an interactive WSL terminal.
    let script = format!("PORT={} exec '{}/run.sh' --watch-stdin", cfg.port, cfg.backend_dir);
    cmd.args(["--cd", "~", "--", "bash", "-lc", &script])
        .stdin(Stdio::piped())
        .stdout(Stdio::from(log_file))
        .stderr(Stdio::from(log_err));
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW

    cmd.spawn().map_err(|e| format!("Cannot start wsl.exe: {e}"))
}

#[tauri::command]
fn backend_info(state: State<AppState>) -> BackendInfo {
    state.info.clone()
}

fn main() {
    let app = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![backend_info])
        .setup(|app| {
            let log = env_dir("LOCALAPPDATA").join("backend.log");
            let _ = fs::create_dir_all(log.parent().unwrap());
            let mut child = None;
            let mut error = None;
            let mut port = 7777;
            match load_config() {
                Ok(cfg) => {
                    port = cfg.port;
                    // An already-running backend (e.g. started by hand) is reused, never duplicated.
                    if !port_open(port) {
                        match spawn_backend(&cfg, &log) {
                            Ok(c) => child = Some(c),
                            Err(e) => error = Some(e),
                        }
                    }
                }
                Err(e) => error = Some(e),
            }
            app.manage(AppState {
                child: Mutex::new(child),
                info: BackendInfo {
                    url: format!("http://127.0.0.1:{port}"),
                    log_path: log.display().to_string(),
                    error,
                },
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the application");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            if let Some(state) = handle.try_state::<AppState>() {
                if let Some(mut child) = state.child.lock().unwrap().take() {
                    drop(child.stdin.take()); // EOF -> backend exits on its own
                    let _ = child.kill(); // belt and braces: stop wsl.exe itself
                    let _ = child.wait();
                }
            }
        }
    });
}
