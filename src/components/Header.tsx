import { useRef, useState } from 'react';
import { api, url, type Conn } from '../api';
import type { Agent, Usage, UsageWindow } from '../types';
import { toggleFullscreen } from '../fullscreen';
import { ago } from '../util';
import { remaining } from './UsagePanel';

function Meter({ label, w }: { label: string; w?: UsageWindow }) {
  if (!w) return null;
  const r = remaining(w);
  const cls = r.used >= 95 ? 'full' : r.used >= 75 ? 'hot' : '';
  return (
    <span className={`u ${cls}`}>
      <span className="u-label">{label}</span>
      <span className="bar"><i style={{ width: `${r.used}%` }} /></span>
      <b>{r.stale ? 'reset' : `${r.used}% used`}</b>
      <span className="u-reset">{r.stale ? 'refresh' : `resets in ${r.left}`}</span>
    </span>
  );
}

interface Props {
  agents: Agent[]; usage: Usage | null; conn: Conn; togetherOpen: boolean;
  showOffline: boolean; setShowOffline: (v: boolean) => void;
  onNew: () => void; onTogether: () => void; onUsage: () => void; onBackground: (file: string | null) => void;
}

export function Header(p: Props) {
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const live = p.agents.filter((a) => a.status !== 'offline').length;
  return (
    <header>
      <span className="brand">&gt;_ agents</span>
      <span className="dim">{live} live / {p.agents.length} total</span>
      <span className="spacer" />
      <button className="usage" onClick={p.onUsage} title={`Plan usage, updated ${ago(p.usage?.updatedAt) || 'never'}. Click for details and tokens per agent.`}>
        {p.usage?.windows ? <>
          <Meter label="session" w={p.usage.windows.five_hour} />
          <Meter label="week" w={p.usage.windows.seven_day} />
        </> : 'usage: loading…'}
      </button>
      <button className="ghost" disabled={busy} title="Refresh usage (sends a 1-token ping)"
        onClick={async () => { setBusy(true); try { await api('/api/usage/refresh', {}); } finally { setBusy(false); } }}>↻</button>
      <span className="sep" />
      <button onClick={p.onNew}>+ new</button>
      <button className={p.togetherOpen ? 'on' : 'ghost'} onClick={p.onTogether}>together</button>
      <button className="ghost" title="Set background photo" onClick={() => file.current?.click()}>bg</button>
      <button className="ghost" title="Full screen (F11)" onClick={() => void toggleFullscreen()}>⛶</button>
      <input ref={file} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={async (e) => {
        const f = e.target.files?.[0]; if (!f) return;
        const r = await fetch(url('/api/background'), { method: 'POST', headers: { 'Content-Type': f.type || 'image/jpeg' }, body: f });
        const d = await r.json();
        if (r.ok) p.onBackground(d.file);
        e.target.value = '';
      }} />
      <label className="chk"><input type="checkbox" checked={p.showOffline} onChange={(e) => p.setShowOffline(e.target.checked)} /> offline</label>
      <span className={`conn ${p.conn === 'live' ? 'ok' : p.conn === 'reconnecting' ? 'bad' : ''}`}>{p.conn === 'live' ? 'live' : p.conn}</span>
    </header>
  );
}
