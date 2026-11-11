import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { Agent, ArtifactItem, ChatEvent, LiveMsg } from '../types';
import { LABEL, MODE, ago, canDelete, resolveName, sessInfo } from '../util';
import { Markdown } from './Markdown';
import { fold, type Item } from '../chatItems';
import { AttachBar, useAttachments } from '../attachments';
import { fmtTokens } from './UsagePanel';
import { PermissionPanel, ScreenView, TerminalKeys } from './Permissions';

interface Props {
  agent: Agent; agents: Agent[];
  subscribe: (fn: (m: LiveMsg) => void) => () => void;
  onClose: () => void; onRename: () => void; onDelete: () => void;
  onFork: (to: string) => void; confirmFork: (title: string, body: string, okLabel: string) => Promise<boolean>;
}

export function ChatPane({ agent, agents, subscribe, onClose, onRename, onDelete, onFork, confirmFork }: Props) {
  const [items, setItems] = useState<Item[]>([]);
  const [arts, setArts] = useState<ArtifactItem[]>([]);
  const [text, setText] = useState('');
  const [tab, setTab] = useState<'chat' | 'terminal'>('chat');
  const att = useAttachments();
  const seen = useRef(new Set<string>());
  const toolNames = useRef(new Map<string, string>());
  const log = useRef<HTMLDivElement>(null);
  const artTimer = useRef<number>(0);
  const id = agent.id;

  const loadArts = useCallback(async () => {
    const { data } = await api<{ items: ArtifactItem[] }>(`/api/agents/${id}/artifacts`);
    setArts(data.items ?? []);
  }, [id]);

  const addEvents = useCallback((evs: ChatEvent[]) => {
    const fresh = evs.filter((e) => !seen.current.has(e.id));
    if (!fresh.length) return;
    let touched = false;
    for (const e of fresh) {
      seen.current.add(e.id);
      if (e.role === 'tool' && e.toolId && e.name) toolNames.current.set(e.toolId, e.name);
      if (e.role === 'result' && !e.error && ['Write', 'Artifact'].includes(toolNames.current.get(e.forId ?? '') ?? '')) touched = true;
    }
    setItems((cur) => fresh.reduce(fold, cur));
    if (touched) { clearTimeout(artTimer.current); artTimer.current = window.setTimeout(loadArts, 600); }
  }, [loadArts]);

  useEffect(() => {
    seen.current = new Set(); toolNames.current = new Map(); setItems([]); setArts([]);
    let live = true;
    api<{ events: ChatEvent[] }>(`/api/agents/${id}/messages`).then(({ data }) => { if (live) addEvents(data.events ?? []); });
    loadArts();
    const off = subscribe((m) => {
      if (m.type === 'messages' && m.id === id) addEvents(m.events);
      else if (m.type === 'note' && m.id === id) setItems((c) => [...c, { k: 'note', id: crypto.randomUUID(), text: m.text, error: m.level === 'error' }]);
      else if (m.type === 'fork' && m.from === id) onFork(m.to);
    });
    return () => { live = false; off(); clearTimeout(artTimer.current); };
  }, [id, subscribe, addEvents, loadArts, onFork]);

  useEffect(() => { log.current?.scrollTo({ top: log.current.scrollHeight }); }, [items]);

  const note = (t: string, error = false) => setItems((c) => [...c, { k: 'note', id: crypto.randomUUID(), text: t, error }]);

  async function send() {
    const t = text.trim();
    if ((!t && !att.names.length) || att.busy) return;
    const images = att.names;
    let r = await api(`/api/agents/${id}/send`, { text: t, fork: false, images });
    if (r.data.needsFork) {
      // Never silently replace or write into a session that is open in a terminal: ask first.
      const ok = await confirmFork('fork session?', `${r.data.error}\n\nFork a copy of this conversation and send there? The original session stays untouched.\n(Or cancel and use "move here" to continue the same session in the dashboard.)`, 'fork and send');
      if (!ok) return;
      r = await api(`/api/agents/${id}/send`, { text: t, fork: true, images });
    }
    if (!r.ok) return note(r.data.error ?? 'Send failed', true);
    setText(''); att.clear();
    if (r.data.via === 'tmux-start') note('opening the real Claude session; your message is typed in as soon as it is ready…');
  }

  return (
    <section className="chat glass">
      <div className="chat-main">
        <div className="chat-head">
          <div className="chat-title">
            <span className="chat-name">{agent.name}</span>
            <button className="ghost sm" onClick={onRename}>edit</button>
            <span className={`status ${agent.status}`}>{LABEL[agent.status]}</span>
          </div>
          <div className="row">
            {canDelete(agent) && <button className="ghost sm danger" onClick={onDelete}>delete</button>}
            <button className="ghost sm" onClick={onClose} title="Close (Esc)">esc</button>
          </div>
        </div>
        <div className="meta pad"><b>session</b> {agent.id}{sessInfo(agent)}{agent.model && <span className="model">{agent.model}</span>}{!!agent.context && <span className="model" title="Conversation size right now">ctx {fmtTokens(agent.context)}</span>}<br /><b>dir</b> {agent.cwd}</div>
        {!!agent.duplicates?.length && (
          <div className="conflict">This session is also open in {agent.duplicates.length} other process{agent.duplicates.length > 1 ? 'es' : ''}
            {' '}({agent.duplicates.map((d) => `pid ${d.pid}${d.tty ? ' · ' + d.tty : ''}`).join(', ')}). Two writers on one history garble it.
            <button className="ghost sm danger" onClick={async () => {
              if (!(await confirmFork('close the other copy?', `This closes the other Claude process on this session (${agent.duplicates!.map((d) => 'pid ' + d.pid).join(', ')}) and keeps the one shown here. The conversation is not deleted. Anything unsent in that terminal is lost.`, 'close it'))) return;
              const r = await api(`/api/agents/${id}/dedupe`, {});
              if (!r.ok) note(r.data.error ?? 'Could not close it', true);
            }}>close the other</button></div>
        )}
        {agent.conflict && !agent.duplicates?.length && (
          <div className="conflict">This session is open in a terminal AND running a dashboard turn. Two writers on one history will garble it: stop the dashboard turn or close the terminal.
            <button className="ghost sm danger" onClick={() => api(`/api/agents/${id}/stop`, {})}>stop dashboard turn</button></div>
        )}
        <div className="mode">{MODE[agent.control]}{agent.isNew ? ' · new agent: the first message starts its session' : ''}</div>
        <div className="tabs">
          <button className={tab === 'chat' ? 'on sm' : 'ghost sm'} onClick={() => setTab('chat')}>chat</button>
          <button className={tab === 'terminal' ? 'on sm' : 'ghost sm'} onClick={() => setTab('terminal')}>terminal</button>
          <span className="spacer" />
          {agent.control === 'managed' && agent.status === 'offline' && <button className="sm" onClick={() => api(`/api/agents/${id}/start`, {})}>start</button>}
          {agent.control === 'fork' && agent.status === 'idle' && (
            <button className="sm" title="Close that terminal's Claude and continue the same session here" onClick={async () => {
              if (!(await confirmFork('move session here?', `This closes the Claude process running in the terminal (pid ${agent.pid}) and continues the SAME session, with its full history, inside the dashboard. Anything unsent in that terminal is lost.`, 'move here'))) return;
              const r = await api(`/api/agents/${id}/adopt`, {});
              if (!r.ok) note(r.data.error ?? 'Could not move the session', true);
            }}>move here</button>
          )}
        </div>
        {tab === 'terminal' ? <><ScreenView agent={agent} /><TerminalKeys agent={agent} always /></> : <div className="log" ref={log}>
          {items.map((it) => {
            if (it.k === 'note') return <div key={it.id} className={`note ${it.error ? 'error' : ''}`}>{it.text}</div>;
            const e = it.e;
            if (it.k === 'tool') {
              return (
                <div key={e.id} className={`tool ${it.results.some((r) => r.error) ? 'err' : ''}`}>
                  <b>{e.name}</b> {e.text}
                  {it.results.map((r, i) => <span key={i} className="res">{r.text}</span>)}
                </div>
              );
            }
            if (e.role === 'peer') {
              return (
                <div key={e.id} className="peer">
                  <span className="who">{e.dir === 'out' ? '→ to' : '← from'} {resolveName(agents, e.peer ?? '')}</span>
                  <div className="msg"><Markdown text={e.text} /></div>
                </div>
              );
            }
            return <div key={e.id} className={`msg ${e.role}`}><Markdown text={e.text} /></div>;
          })}
        </div>}
        <PermissionPanel agent={agent} />
        {tab === 'chat' && <TerminalKeys agent={agent} />}
        <AttachBar att={att} />
        <form className="form" onSubmit={(ev) => { ev.preventDefault(); void send(); }} onDrop={att.onDrop} onDragOver={att.onDragOver}>
          <span className="prompt">$</span>
          <textarea rows={1} value={text} onPaste={att.onPaste} placeholder="message or /command, sent exactly like in the terminal" autoFocus
            onChange={(e) => { setText(e.target.value); e.target.style.height = 'auto'; e.target.style.height = `${e.target.scrollHeight}px`; }}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }} />
          {(agent.managedRun || (agent.control === 'tmux' && agent.status === 'working')) && <button type="button" className="ghost" title="Interrupt (Esc)" onClick={() => api(`/api/agents/${id}/stop`, {})}>stop</button>}
          <button type="submit" disabled={agent.managedRun || agent.control === 'readonly'}>send</button>
        </form>
      </div>
      <aside className="arts">
        <div className="arts-title">artifacts</div>
        <div className="art-list">
          {arts.length === 0 && <div className="art-empty">nothing produced yet</div>}
          {arts.map((a) => (
            <div key={a.url ?? a.path} className="art">
              <div className="k">{a.kind}</div>
              {a.kind === 'artifact'
                ? <a href={a.url} target="_blank" rel="noopener noreferrer">{a.name}</a>
                : <>{a.name}<div className="p">{a.winPath}</div><CopyButton text={a.winPath ?? ''} /></>}
              <div className="p">{ago(Date.parse(a.ts))}</div>
            </div>
          ))}
        </div>
      </aside>
    </section>
  );
}

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return <button className="ghost sm" onClick={() => { void navigator.clipboard.writeText(text); setDone(true); }}>{done ? 'copied' : 'copy path'}</button>;
}
