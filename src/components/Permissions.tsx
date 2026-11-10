import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { Agent, Permission, Question } from '../types';

const answer = (agent: Agent, p: Permission, body: object) =>
  api(`/api/agents/${agent.id}/permission`, { requestId: p.requestId, ...body });

/** Approval requests and questions from a dashboard-run agent: the same decisions a terminal would ask for. */
export function PermissionPanel({ agent }: { agent: Agent }) {
  if (!agent.permissions?.length) return null;
  return (
    <div className="perms">
      {agent.permissions.map((p) => (p.tool === 'AskUserQuestion' && p.input.questions
        ? <QuestionCard key={p.requestId} agent={agent} p={p} questions={p.input.questions} />
        : <ApprovalCard key={p.requestId} agent={agent} p={p} />))}
    </div>
  );
}

function ApprovalCard({ agent, p }: { agent: Agent; p: Permission }) {
  const [busy, setBusy] = useState(false);
  const decide = async (allow: boolean, remember = false) => { setBusy(true); await answer(agent, p, { allow, remember }); };
  return (
    <div className="perm">
      <div className="perm-title">approval needed · <b>{p.tool}</b></div>
      {(p.reason || p.description) && <div className="meta">{[p.reason, p.description].filter(Boolean).join(' · ')}</div>}
      <pre className="perm-input">{Object.entries(p.input).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join('\n')}</pre>
      <div className="row">
        <button disabled={busy} onClick={() => decide(true)}>allow</button>
        {p.canRemember && <button className="ghost" disabled={busy} onClick={() => decide(true, true)} title="Also apply the CLI's suggested rule for the rest of this session">allow for session</button>}
        <button className="ghost danger" disabled={busy} onClick={() => decide(false)}>deny</button>
      </div>
    </div>
  );
}

function QuestionCard({ agent, p, questions }: { agent: Agent; p: Permission; questions: Question[] }) {
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState(false);
  const toggle = (q: Question, label: string) => setPicked((cur) => {
    const have = cur[q.question] ?? [];
    return { ...cur, [q.question]: q.multiSelect ? (have.includes(label) ? have.filter((l) => l !== label) : [...have, label]) : [label] };
  });
  const ready = questions.every((q) => (picked[q.question] ?? []).length > 0);
  return (
    <div className="perm">
      <div className="perm-title">the agent asks you</div>
      {questions.map((q) => (
        <div key={q.question} className="q">
          <div>{q.header && <span className="k">{q.header} · </span>}{q.question}</div>
          <div className="row wrap">
            {q.options.map((o) => (
              <button key={o.label} className={(picked[q.question] ?? []).includes(o.label) ? 'on' : 'ghost'} title={o.description}
                onClick={() => toggle(q, o.label)}>{o.label}</button>
            ))}
          </div>
        </div>
      ))}
      <div className="row">
        <button disabled={!ready || busy} onClick={async () => {
          setBusy(true);
          await answer(agent, p, { allow: true, answers: Object.fromEntries(Object.entries(picked).map(([q, l]) => [q, l.join(', ')])) });
        }}>send answer</button>
        <button className="ghost danger" disabled={busy} onClick={async () => { setBusy(true); await answer(agent, p, { allow: false }); }}>skip</button>
      </div>
    </div>
  );
}

/** Press the same keys you would in the real terminal. `always` = the Terminal tab; otherwise only while waiting. */
export function TerminalKeys({ agent, always = false }: { agent: Agent; always?: boolean }) {
  if (agent.control !== 'tmux' || (!always && agent.status !== 'waiting')) return null;
  const press = (k: string) => void api(`/api/agents/${agent.id}/keys`, { keys: [k] });
  const keys: [string, string, boolean][] = [['Enter', 'enter', true], ['Escape', 'esc', false], ['Up', '↑', false], ['Down', '↓', false],
    ['Left', '←', false], ['Right', '→', false], ['Tab', 'tab', false], ['BTab', 'shift+tab', false], ['C-c', 'ctrl+c', false],
    ['1', '1', false], ['2', '2', false], ['3', '3', false]];
  return (
    <div className={always ? 'keybar' : 'perm'}>
      {!always && <div className="perm-title">terminal is waiting for input{agent.waitingFor ? ` · ${agent.waitingFor}` : ''}</div>}
      <div className="row wrap">
        {keys.map(([k, label, primary]) => <button key={k} className={primary ? '' : 'ghost'} onClick={() => press(k)}>{label}</button>)}
      </div>
      {!always && <div className="meta">Or type a reply below and press enter.</div>}
    </div>
  );
}

/** Live view of the real terminal (permission dialogs, slash-command output, everything the CLI shows). */
export function ScreenView({ agent }: { agent: Agent }) {
  const [text, setText] = useState('');
  useEffect(() => {
    if (agent.control !== 'tmux') { setText(''); return; }
    let stop = false;
    const tick = async () => {
      const r = await api<{ text: string }>(`/api/agents/${agent.id}/screen`).catch(() => null);
      if (!stop && r) setText(r.data.text);
    };
    void tick();
    const t = window.setInterval(tick, 800);
    return () => { stop = true; clearInterval(t); };
  }, [agent.id, agent.control]);
  const box = useRef<HTMLPreElement>(null);
  useEffect(() => { box.current?.scrollTo({ top: box.current.scrollHeight }); }, [text]);
  if (agent.control !== 'tmux') {
    return <div className="screen empty-screen">No live terminal. {agent.control === 'managed' ? 'Press start to open this session in the real CLI.' : ''}</div>;
  }
  return <pre className="screen" ref={box}>{text || '…'}</pre>;
}
