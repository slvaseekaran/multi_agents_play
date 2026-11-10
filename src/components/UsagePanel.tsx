import { useEffect, useState } from 'react';
import { api } from '../api';
import type { Usage, UsageWindow } from '../types';
import { ago } from '../util';

interface Row { id: string; name: string; model: string; status: string; turns: number; output: number; fresh: number; cacheRead: number; peak: number; context: number }

export const fmtTokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

export function windowLabel(key: string): string {
  if (key === 'five_hour') return 'Current session (5 h)';
  if (key === 'seven_day') return 'Current week · all models';
  const m = key.match(/^seven_day_(.+)$/);
  return m ? `Current week · ${m[1].replace(/_/g, ' ')}` : key.replace(/_/g, ' ');
}
const order = (k: string) => (k === 'five_hour' ? 0 : k === 'seven_day' ? 1 : 2);

export function remaining(w: UsageWindow) {
  const ms = w.resetsAt * 1000 - Date.now();
  const stale = ms <= 0;
  const used = stale ? 0 : Math.round((w.utilization ?? 0) * 100);
  const m = Math.max(0, Math.round(ms / 60000));
  const left = m >= 1440 ? `${(m / 1440) | 0}d ${((m % 1440) / 60) | 0}h` : `${(m / 60) | 0}h${String(m % 60).padStart(2, '0')}m`;
  const at = new Date(w.resetsAt * 1000).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  return { stale, used, left, at };
}

/** Same information as the CLI's /usage: plan limits (used, left, reset) and tokens per agent. */
export function UsagePanel({ usage, onClose }: { usage: Usage | null; onClose: () => void }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [window_, setWindow] = useState(1_000_000);
  const [busy, setBusy] = useState(false);
  const [, tick] = useState(0);

  useEffect(() => {
    let stop = false;
    const load = async () => {
      const r = await api<{ rows: Row[]; contextWindow: number }>('/api/usage/agents').catch(() => null);
      if (!stop && r) { setRows(r.data.rows ?? []); setWindow(r.data.contextWindow ?? 1_000_000); }
    };
    void load();
    const t = window.setInterval(() => { void load(); tick((n) => n + 1); }, 10000);
    return () => { stop = true; clearInterval(t); };
  }, []);

  const wins = Object.entries(usage?.windows ?? {}).sort((a, b) => order(a[0]) - order(b[0]) || a[0].localeCompare(b[0]));
  return (
    <div className="usage-overlay" onClick={onClose}>
      <div className="usage-panel glass" onClick={(e) => e.stopPropagation()}>
        <div className="chat-head">
          <div className="chat-title"><span className="chat-name">usage</span>
            <span className="dim">{usage?.updatedAt ? `updated ${ago(usage.updatedAt)}` : 'not loaded yet'}</span></div>
          <div className="row">
            <button className="sm" disabled={busy} onClick={async () => { setBusy(true); try { await api('/api/usage/refresh', {}); } finally { setBusy(false); } }}>
              {busy ? 'refreshing…' : 'refresh now'}</button>
            <button className="ghost sm" onClick={onClose}>close</button>
          </div>
        </div>
        <div className="usage-body">
          <h3>plan limits</h3>
          {wins.length === 0 && <div className="dim">No data yet. Press refresh now.</div>}
          {wins.map(([key, w]) => {
            const r = remaining(w);
            const cls = r.used >= 95 ? 'full' : r.used >= 75 ? 'hot' : '';
            return (
              <div key={key} className={`lim ${cls}`}>
                <div className="lim-top"><span>{windowLabel(key)}</span>
                  <span><b>{r.stale ? 'window reset' : `${r.used}% used`}</b>{!r.stale && <> · {100 - r.used}% left</>}</span></div>
                <div className="lim-bar"><i style={{ width: `${r.used}%` }} /></div>
                <div className="meta">{r.stale ? 'This window has reset; press refresh now.' : `resets in ${r.left} · ${r.at}`}</div>
              </div>
            );
          })}

          <h3>tokens per agent</h3>
          <div className="meta">Context = size of the conversation the agent carries right now (of a {fmtTokens(window_)} window). Output and fresh input
            are what it has produced and newly sent over its whole history; cached input is re-read context.</div>
          <table className="tok">
            <thead><tr><th>agent</th><th>model</th><th>context</th><th>turns</th><th>output</th><th>fresh in</th><th>cached in</th></tr></thead>
            <tbody>
              {rows.map((r) => {
                const pct = Math.min(100, Math.round((r.context / window_) * 100));
                return (
                  <tr key={r.id}>
                    <td className="tok-name">{r.name}<span className={`status ${r.status}`}>{r.status}</span></td>
                    <td>{r.model}</td>
                    <td><div className="ctx"><i className={pct >= 80 ? 'full' : pct >= 50 ? 'hot' : ''} style={{ width: `${pct}%` }} /></div>{fmtTokens(r.context)} · {pct}%</td>
                    <td>{r.turns}</td><td>{fmtTokens(r.output)}</td><td>{fmtTokens(r.fresh)}</td><td>{fmtTokens(r.cacheRead)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
