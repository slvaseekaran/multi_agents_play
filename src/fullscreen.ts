import { IN_TAURI } from './api';

/** Toggle full screen: native window in the desktop app, the Fullscreen API in a plain browser. */
export async function toggleFullscreen(): Promise<void> {
  if (IN_TAURI) {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const w = getCurrentWindow();
    await w.setFullscreen(!(await w.isFullscreen()));
  } else if (document.fullscreenElement) {
    await document.exitFullscreen();
  } else {
    await document.documentElement.requestFullscreen();
  }
}
