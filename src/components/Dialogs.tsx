import { useEffect, useRef, useState } from 'react';
import type { Agent, Team, TeamMember } from '../types';
import { LABEL } from '../util';

export type Modal =
  | { kind: 'team'; agents: Agent[]; team: Team | null; onSave: (name: string, members: TeamMember[]) => Promise<string | null> }
  | { kind: 'rename'; agent: Agent }
  | { kind: 'new'; cwds: string[]; onCreate: (name: string, cwd: string) => Promise<string | null> }
  | { kind: 'confirm'; title: string; body: string; okLabel: string; danger?: boolean; onOk: () => void };

function Shell({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  return <dialog ref={ref} onClose={onClose} onCancel={onClose}>{children}</dialog>;
}

export function ModalHost({ modal, onClose, onRename }: { modal: Modal | null; onClose: () => void; onRename: (a: Agent, name: string) => void }) {
  if (!modal) return null;
  if (modal.kind === 'rename') return <RenameDialog agent={modal.agent} onClose={onClose} onRename={onRename} />;
  if (modal.kind === 'new') return <NewDialog modal={modal} onClose={onClose} />;
  if (modal.kind === 'team') return <TeamDialog modal={modal} onClose={onClose} />;
  return (
    <Shell onClose={onClose}>
      <h2>&gt; {modal.title}</h2>
      <p className="dlg-body">{modal.body}</p>
      <div className="row end">
        <button className="ghost" onClick={onClose}>cancel</button>
        <button className={modal.danger ? 'danger-solid' : ''} onClick={() => { modal.onOk(); onClose(); }} autoFocus>{modal.okLabel}</button>
      </div>
    </Shell>
  );
}

function RenameDialog({ agent, onClose, onRename }: { agent: Agent; onClose: () => void; onRename: (a: Agent, n: string) => void }) {
  const [name, setName] = useState(agent.name);
  return (
    <Shell onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); onRename(agent, name); onClose(); }}>
        <h2>&gt; rename agent</h2>
        <label>name (empty resets to the default)<input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoFocus /></label>
        <div className="row end"><button type="button" className="ghost" onClick={onClose}>cancel</button><button type="submit">save</button></div>
      </form>
    </Shell>
  );
}

function TeamDialog({ modal, onClose }: { modal: Extract<Modal, { kind: 'team' }>; onClose: () => void }) {
  const [name, setName] = useState(modal.team?.name ?? '');
  const [picked, setPicked] = useState<Map<string, string>>(
    new Map((modal.team?.members ?? []).map((m) => [m.id, m.name] as const)),
  );
  const [err, setErr] = useState('');
  const toggle = (a: Agent) => setPicked((cur) => {
    const next = new Map(cur);
    if (next.has(a.id)) next.delete(a.id); else next.set(a.id, a.origName);
    return next;
  });
  // live agents first: they are the ones that can exchange messages right now
  const sorted = [...modal.agents].sort((a, b) => Number(b.status !== 'offline') - Number(a.status !== 'offline'));
  return (
    <Shell onClose={onClose}>
      <form onSubmit={async (e) => {
        e.preventDefault();
        const msg = await modal.onSave(name, [...picked].map(([id, n]) => ({ id, name: n })));
        if (msg) setErr(msg); else onClose();
      }}>
        <h2>&gt; {modal.team ? 'edit team' : 'new team'}</h2>
        <label>team name<input value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} placeholder="e.g. calc + cad" autoFocus /></label>
        <div className="pick-title">members (pick at least two)</div>
        <div className="pick-list">
          {sorted.map((a) => (
            <label key={a.id} className="pick">
              <input type="checkbox" checked={picked.has(a.id)} onChange={() => toggle(a)} />
              <span className="pick-name">{a.name}</span>
              {a.model && <span className="model">{a.model}</span>}
              <span className={`status ${a.status}`}>{LABEL[a.status]}</span>
            </label>
          ))}
        </div>
        {err && <div className="note error">{err}</div>}
        <div className="row end"><button type="button" className="ghost" onClick={onClose}>cancel</button><button type="submit">{modal.team ? 'save' : 'create'}</button></div>
      </form>
    </Shell>
  );
}

function NewDialog({ modal, onClose }: { modal: Extract<Modal, { kind: 'new' }>; onClose: () => void }) {
  const [name, setName] = useState('');
  const [cwd, setCwd] = useState('');
  const [err, setErr] = useState('');
  return (
    <Shell onClose={onClose}>
      <form onSubmit={async (e) => {
        e.preventDefault();
        const msg = await modal.onCreate(name, cwd.trim());
        if (msg) setErr(msg); else onClose();
      }}>
        <h2>&gt; new agent</h2>
        <label>name<input value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} placeholder="e.g. api-refactor" autoFocus /></label>
        <label>working directory (WSL path)
          <input value={cwd} onChange={(e) => setCwd(e.target.value)} required list="cwds" placeholder="/home/you/project" />
        </label>
        <datalist id="cwds">{modal.cwds.map((c) => <option key={c} value={c} />)}</datalist>
        {err && <div className="note error">{err}</div>}
        <div className="row end"><button type="button" className="ghost" onClick={onClose}>cancel</button><button type="submit">create</button></div>
      </form>
    </Shell>
  );
}
