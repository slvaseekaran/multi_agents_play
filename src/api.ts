import { useCallback, useEffect, useRef, useState } from 'react';
import type { Agent, LiveMsg, Team, Usage } from './types';

export const IN_TAURI = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
let base = IN_TAURI || import.meta.env.DEV ? 'http://127.0.0.1:7777' : location.origin;

export interface BackendInfo { url: string; logPath: string; error?: string }

/** In the desktop app the Rust side owns the backend process and tells us where it lives. */
export async function initBackend(): Promise<BackendInfo | null> {
  if (!IN_TAURI) return null;
  const { invoke } = await import('@tauri-apps/api/core');
  const info = await invoke<BackendInfo>('backend_info');
  base = info.url;
  return info;
}

export const url = (path: string) => base + path;

export async function api<T = any>(path: string, body?: unknown): Promise<{ ok: boolean; data: T }> {
  const r = await fetch(url(path), body === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { ok: r.ok, data: await r.json().catch(() => ({})) };
}

export async function healthy(): Promise<boolean> {
  try {
    const r = await fetch(url('/api/health'), { cache: 'no-store' });
    return (await r.json()).app === 'agent-dashboard';
  } catch { return false; }
}

export type Conn = 'connecting' | 'live' | 'reconnecting';

/** Live agent list, usage and per-agent message stream, all from one SSE connection. */
export function useDashboard() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [teams, setTeams] = useState<Team[]>([]);
  const [conn, setConn] = useState<Conn>('connecting');
  const subs = useRef(new Set<(m: LiveMsg) => void>());

  useEffect(() => {
    const es = new EventSource(url('/api/events'));
    es.onopen = () => setConn('live');
    es.onerror = () => setConn('reconnecting');
    es.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d.type === 'agents') setAgents(d.agents);
      else if (d.type === 'usage') setUsage(d.usage);
      else if (d.type === 'teams') setTeams(d.teams);
      else subs.current.forEach((fn) => fn(d as LiveMsg));
    };
    return () => es.close();
  }, []);

  const subscribe = useCallback((fn: (m: LiveMsg) => void) => {
    subs.current.add(fn);
    return () => { subs.current.delete(fn); };
  }, []);
  return { agents, usage, conn, teams, subscribe };
}

