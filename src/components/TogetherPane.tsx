import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api';
import { fold, type Item } from '../chatItems';
import type { Agent, ChatEvent, LiveMsg, Team } from '../types';
import { LABEL, resolveName, tagColor } from '../util';
import { Markdown } from './Markdown';
import { PermissionPanel, TerminalKeys } from './Permissions';

interface Props {
  agents: Agent[];
  teams: Team[];
  subscribe: (fn: (m: LiveMsg) => void) => () => void;
  onClose: () => void;
  onOpenAgent: (id: string) => void;
  onEditTeam: (team: Team | null) => void;
  onDeleteTeam: (team: Team) => void;
}

interface Note { key: number; from: string; to: string; text: string }

/**
 * A team page: one chat panel per member, so every agent can be prompted from here. When one member sends a
 * message to another, a sheet of paper is written, thrown across the page, and opened by the receiver.
 * The animation is purely visual: the agents themselves work exactly as before.
 */
export function Together({ agents, teams, subscribe, onClose, onOpenAgent, onEditTeam, onDeleteTeam }: Props) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const team = teams.find((t) => t.id === activeId) ?? teams[0] ?? null;
  const members = useMemo(
    () => (team ? team.members.map((m) => agents.find((a) => a.id === m.id) ?? agents.find((a) => a.origName === m.name || a.name === m.name))
      .filter((a): a is Agent => !!a) : []),
    [team, agents],
  );
  const missing = team ? team.members.length - members.length : 0;

  // ---- paper notes between members
  const heads = useRef(new Map<string, HTMLElement>());
  const [notes, setNotes] = useState<Note[]>([]);
  const [reading, setReading] = useState<Record<string, number>>({});
  const recent = useRef(new Map<string, number>());
  const seq = useRef(0);
  const membersRef = useRef(members);
  membersRef.current = members;

  const throwNote = useCallback((from: string, to: string, text: string) => {
    const key = `${from}>${to}:${text.slice(0, 60)}`;
    const now = Date.now();
    if (now - (recent.current.get(key) ?? 0) < 8000) return; // sender's "out" and receiver's "in" are one message
    recent.current.set(key, now);
    setNotes((n) => [...n, { key: ++seq.current, from, to, text }]);
  }, []);

  useEffect(() => subscribe((m) => {
    if (m.type !== 'messages') return;
    const ids = new Set(membersRef.current.map((x) => x.id));
    if (!ids.has(m.id)) return;
    for (const e of m.events) {
      if (e.role !== 'peer') continue;
      const other = agents.find((x) => x.origName === e.peer || x.name === e.peer || x.id === e.peer);
      if (!other || !ids.has(other.id) || other.id === m.id) continue;
      if (e.dir === 'out') throwNote(m.id, other.id, e.text); else throwNote(other.id, m.id, e.text);
    }
  }), [subscribe, agents, throwNote]);

  const startAll = () => members.filter((a) => a.status === 'offline' && a.control === 'managed')
    .forEach((a) => void api(`/api/agents/${a.id}/start`, {}));

  return (
    <section className="chat glass together">
      <div className="chat-head">
        <div className="chat-title">
          <span className="chat-name">together</span>
          {teams.map((t) => <button key={t.id} className={t.id === team?.id ? 'on sm' : 'ghost sm'} onClick={() => setActiveId(t.id)}>{t.name}</button>)}
          <button className="ghost sm" onClick={() => onEditTeam(null)}>+ team</button>
        </div>
        <div className="row">
          {team && members.some((a) => a.status === 'offline') && <button className="sm" onClick={startAll}>start all</button>}
          {team && <button className="ghost sm" onClick={() => onEditTeam(team)}>edit team</button>}
          {team && <button className="ghost sm danger" onClick={() => onDeleteTeam(team)}>delete team</button>}
          <button className="ghost sm" onClick={onClose}>esc</button>
        </div>
      </div>
      {!team ? (
        <div className="empty-team">
          <div>no team yet<span className="cursor">_</span></div>
          <div className="dim">Pick the agents that work together. Each gets its own chat panel on this page.</div>
          <button onClick={() => onEditTeam(null)}>+ create a team</button>
        </div>
      ) : (
        <>
          <div className="mode">One panel per agent: prompt any of them here. When one agent messages another, the note is passed across the page.
            {missing > 0 && <span className="note error"> {missing} member(s) no longer exist.</span>}</div>
          <div className="cols">
            {members.map((a) => (
              <Column key={a.id} agent={a} agents={agents} subscribe={subscribe} reading={reading[a.id] !== undefined}
                setHead={(el) => { if (el) heads.current.set(a.id, el); else heads.current.delete(a.id); }} onOpen={() => onOpenAgent(a.id)} />
            ))}
          </div>
        </>
      )}
      {/* Portal to <body>: the glass panel's blur makes fixed children relative to itself and clips them. */}
      {notes.map((n) => createPortal(
        <PaperNote key={n.key} note={n} agents={agents} heads={heads}
          onArrive={() => setReading((r) => ({ ...r, [n.to]: n.key }))}
          onDone={() => {
            setReading((r) => { if (r[n.to] !== n.key) return r; const { [n.to]: _gone, ...rest } = r; return rest; });
            setNotes((cur) => cur.filter((x) => x.key !== n.key));
          }} />,
        document.body, String(n.key)))}
    </section>
  );
}

/** One agent's own chat panel inside the team page. */
function Column({ agent, agents, subscribe, setHead, reading, onOpen }: {
  agent: Agent; agents: Agent[]; subscribe: Props['subscribe']; setHead: (el: HTMLElement | null) => void; reading: boolean; onOpen: () => void;
}) {
  const id = agent.id;
  const [items, setItems] = useState<Item[]>([]);
  const [text, setText] = useState('');
  const seen = useRef(new Set<string>());
  const log = useRef<HTMLDivElement>(null);
  const color = tagColor(id);

  const add = useCallback((evs: ChatEvent[]) => {
    const fresh = evs.filter((e) => !seen.current.has(e.id));
    if (!fresh.length) return;
    fresh.forEach((e) => seen.current.add(e.id));
    setItems((cur) => fresh.reduce(fold, cur));
  }, []);

  useEffect(() => {
    seen.current = new Set(); setItems([]);
    let live = true;
    void api<{ events: ChatEvent[] }>(`/api/agents/${id}/messages?limit=60`).then(({ data }) => { if (live) add(data.events ?? []); });
    const off = subscribe((m) => {
      if (m.type === 'messages' && m.id === id) add(m.events);
      else if (m.type === 'note' && m.id === id) setItems((c) => [...c, { k: 'note', id: crypto.randomUUID(), text: m.text, error: m.level === 'error' }]);
    });
    return () => { live = false; off(); };
  }, [id, subscribe, add]);
  useEffect(() => { log.current?.scrollTo({ top: log.current.scrollHeight }); }, [items]);

  const note = (t: string, error = false) => setItems((c) => [...c, { k: 'note', id: crypto.randomUUID(), text: t, error }]);
  async function send() {
    const t = text.trim();
    if (!t) return;
    const r = await api(`/api/agents/${id}/send`, { text: t, fork: false });
    if (r.data.needsFork) return note('This session is open in a plain terminal. Open it in the chat view to move it here or fork it.', true);
    if (!r.ok) return note(r.data.error ?? 'Send failed', true);
    setText('');
    if (r.data.via === 'tmux-start') note('opening the real Claude session; your message is typed in when it is ready…');
  }

  return (
    <div className={`col${reading ? ' reading' : ''}`} style={{ borderColor: color }}>
      <div className="col-head" ref={setHead}>
        <div className="col-title">
          <span className="name" style={{ color }}>{agent.name}</span>
          {agent.model && <span className="model">{agent.model}</span>}
        </div>
        <div className="row">
          <span className={`status ${agent.status}`}>{reading ? 'reading…' : LABEL[agent.status]}</span>
          {agent.control === 'managed' && agent.status === 'offline' && <button className="sm" onClick={() => api(`/api/agents/${id}/start`, {})}>start</button>}
          {(agent.managedRun || (agent.control === 'tmux' && agent.status === 'working')) &&
            <button className="ghost sm" title="Interrupt (Esc)" onClick={() => api(`/api/agents/${id}/stop`, {})}>stop</button>}
          <button className="ghost sm" onClick={onOpen} title="Open the full chat with terminal view">open</button>
        </div>
      </div>
      <div className="col-log" ref={log}>
        {items.map((it) => {
          if (it.k === 'note') return <div key={it.id} className={`note ${it.error ? 'error' : ''}`}>{it.text}</div>;
          const e = it.e;
          if (it.k === 'tool') return <div key={e.id} className={`tool ${it.results.some((r) => r.error) ? 'err' : ''}`}><b>{e.name}</b> {e.text.slice(0, 140)}</div>;
          if (e.role === 'peer') {
            return (
              <div key={e.id} className="peer">
                <span className="who">{e.dir === 'out' ? '→ to' : '← from'} {resolveName(agents, e.peer ?? '')}</span>
                <div className="msg"><Markdown text={e.text.slice(0, 900)} /></div>
              </div>
            );
          }
          return <div key={e.id} className={`msg ${e.role}`}><Markdown text={e.text.slice(0, 1800)} /></div>;
        })}
      </div>
      <PermissionPanel agent={agent} />
      <TerminalKeys agent={agent} />
      <form className="form" onSubmit={(ev) => { ev.preventDefault(); void send(); }}>
        <span className="prompt">$</span>
        <textarea rows={1} value={text} placeholder={`message ${agent.name}`}
          onChange={(e) => { setText(e.target.value); e.target.style.height = 'auto'; e.target.style.height = `${e.target.scrollHeight}px`; }}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }} />
        <button type="submit" disabled={agent.control === 'readonly'}>send</button>
      </form>
    </div>
  );
}

type Phase = 'write' | 'fly' | 'open' | 'close';

/** The paper: written next to the sender, thrown to the receiver, unfolded and read, then folded away. */
function PaperNote({ note, agents, heads, onArrive, onDone }: {
  note: Note; agents: Agent[]; heads: React.RefObject<Map<string, HTMLElement>>; onArrive: () => void; onDone: () => void;
}) {
  const [phase, setPhase] = useState<Phase>('write');
  const fly = useRef<HTMLDivElement>(null);
  const [dest, setDest] = useState<DOMRect | null>(null);
  const W = 54, H = 68;
  const center = (el: HTMLElement | undefined) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, r };
  };

  useEffect(() => {
    const a = center(heads.current?.get(note.from)), b = center(heads.current?.get(note.to));
    if (!a || !b) { onDone(); return; }
    const el = fly.current!;
    const at = (p: { x: number; y: number }, rot: number, scale: number) => `translate(${p.x - W / 2}px, ${p.y - H / 2}px) rotate(${rot}deg) scale(${scale})`;
    const timers: number[] = [];
    // 1) written next to the sender
    el.animate([{ transform: at(a, -10, 0.3), opacity: 0 }, { transform: at(a, -6, 1.15), opacity: 1 }], { duration: 450, fill: 'forwards', easing: 'ease-out' });
    timers.push(window.setTimeout(() => {
      // 2) thrown over the page, tumbling, to the receiver
      const mid = { x: (a.x + b.x) / 2, y: Math.min(a.y, b.y) - 110 };
      setPhase('fly');
      el.animate([
        { transform: at(a, -6, 1.15), offset: 0 },
        { transform: at(mid, 170, 1.0), offset: 0.5 },
        { transform: at({ x: b.x, y: b.y + 6 }, 350, 0.75), offset: 1 },
      ], { duration: 1150, fill: 'forwards', easing: 'ease-in-out' });
    }, 1150));
    timers.push(window.setTimeout(() => {
      // 3) the receiver opens it and reads
      setDest(b.r); setPhase('open'); onArrive();
    }, 2350));
    timers.push(window.setTimeout(() => setPhase('close'), 2350 + 5200));
    timers.push(window.setTimeout(onDone, 2350 + 5200 + 500));
    return () => timers.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const from = resolveName(agents, agents.find((x) => x.id === note.from)?.name ?? note.from);
  if (phase === 'open' || phase === 'close') {
    if (!dest) return null;
    const width = Math.min(Math.max(dest.width - 16, 240), 380);
    return (
      <div key="sheet" className={`sheet ${phase === 'close' ? 'closing' : ''}`} style={{ left: dest.left + (dest.width - width) / 2, top: dest.bottom + 6, width }}
        onClick={() => setPhase('close')} title="click to put it away">
        <div className="sheet-from">note from {from}</div>
        <div className="sheet-body">{note.text.slice(0, 700)}</div>
      </div>
    );
  }
  // distinct key: the flying paper's animation must not carry over to the unfolded sheet
  return <div key="paper" ref={fly} className={`paper-fly ${phase === 'write' ? 'writing' : ''}`} />;
}
