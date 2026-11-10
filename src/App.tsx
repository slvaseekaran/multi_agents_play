import { useCallback, useEffect, useRef, useState } from 'react';
import { api, url, useDashboard } from './api';
import { toggleFullscreen } from './fullscreen';
import { AgentList } from './components/AgentList';
import { ChatPane } from './components/ChatPane';
import { Header } from './components/Header';
import { ModalHost, type Modal } from './components/Dialogs';
import { Startup } from './components/Startup';
import { UsagePanel } from './components/UsagePanel';
import { Together } from './components/TogetherPane';
import type { Agent, Team, TeamMember } from './types';

type View = { kind: 'none' } | { kind: 'chat'; id: string } | { kind: 'together' };

function Dashboard() {
  const { agents, usage, conn, teams, subscribe } = useDashboard();
  const [view, setView] = useState<View>({ kind: 'none' });
  const [modal, setModal] = useState<Modal | null>(null);
  const [showOffline, setShowOffline] = useState(true);
  const [showUsage, setShowUsage] = useState(false);

  // --- background photo (set from the UI, served by the backend)
  const setPhoto = useCallback((file: string | null) => {
    document.documentElement.style.setProperty('--photo', file ? `url(${url(`/bg/${file}`)}?v=${Date.now()})` : 'none');
  }, []);
  useEffect(() => { api<{ file: string | null }>('/api/background').then((r) => setPhoto(r.data.file)); }, [setPhoto]);

  const closeView = useCallback(() => setView({ kind: 'none' }), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F11') { e.preventDefault(); void toggleFullscreen(); }
      else if (e.key === 'Escape' && !modal) { if (showUsage) setShowUsage(false); else closeView(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [modal, closeView, showUsage]);

  const info = (title: string, body: string) =>
    setModal({ kind: 'confirm', title, body, okLabel: 'ok', onOk: () => {} });

  const rename = (a: Agent) => setModal({ kind: 'rename', agent: a });
  const remove = (a: Agent) => setModal({
    kind: 'confirm', title: 'delete agent', okLabel: a.status === 'idle' ? 'close terminal and delete' : 'delete', danger: true,
    body: a.status === 'idle'
      ? `"${a.name}" (${a.id.slice(0, 8)}) is an idle live terminal session (pid ${a.pid}).\n\nDeleting will CLOSE that Claude process and permanently delete its conversation history. This cannot be undone.`
      : `Delete "${a.name}" (${a.id.slice(0, 8)}) and its conversation history? This cannot be undone.`,
    onOk: async () => {
      const r = await api(`/api/agents/${a.id}/delete`, {});
      if (!r.ok) return info('cannot delete', r.data.error ?? 'Delete failed');
      setView((v) => (v.kind === 'chat' && v.id === a.id ? { kind: 'none' } : v));
    },
  });
  const newAgent = () => setModal({
    kind: 'new', cwds: [...new Set(agents.map((a) => a.cwd).filter(Boolean))],
    onCreate: async (name, cwd) => {
      const r = await api<{ id: string }>('/api/agents', { name, cwd });
      if (!r.ok) return (r.data as any).error ?? 'Could not create agent';
      setView({ kind: 'chat', id: r.data.id });
      return null;
    },
  });

  // --- teams
  const editTeam = (team: Team | null) => setModal({
    kind: 'team', agents, team,
    onSave: async (name: string, members: TeamMember[]) => {
      const r = await api(team ? `/api/teams/${team.id}/update` : '/api/teams', { name, members });
      return r.ok ? null : (r.data as any).error ?? 'Could not save team';
    },
  });
  const deleteTeam = (team: Team) => setModal({
    kind: 'confirm', title: 'delete team', okLabel: 'delete team', danger: true,
    body: `Delete the team "${team.name}"? The agents themselves are not touched.`,
    onOk: () => { void api(`/api/teams/${team.id}/delete`, {}); },
  });

  const pending = useRef<((v: boolean) => void) | null>(null);
  const confirmFork = (title: string, body: string, okLabel: string) => new Promise<boolean>((resolve) => {
    pending.current = resolve; // closing the dialog without OK resolves false (see closeModal)
    setModal({ kind: 'confirm', title, body, okLabel, onOk: () => resolve(true) });
  });
  const closeModal = () => { pending.current?.(false); pending.current = null; setModal(null); };

  const selected = view.kind === 'chat' ? view.id : null;
  const current = agents.find((a) => a.id === selected);
  const shown = agents.filter((a) => showOffline || a.status !== 'offline');
  const wide = view.kind === 'none' || (view.kind === 'chat' && !current);

  return (
    <div className="app">
      <Header agents={agents} usage={usage} conn={conn} togetherOpen={view.kind === 'together'}
        onUsage={() => setShowUsage(true)} showOffline={showOffline} setShowOffline={setShowOffline} onNew={newAgent} onBackground={setPhoto}
        onTogether={() => setView(view.kind === 'together' ? { kind: 'none' } : { kind: 'together' })} />
      <main>
        <AgentList agents={shown} selected={selected} wide={wide} onSelect={(id) => setView({ kind: 'chat', id })}
          onRename={rename} onDelete={remove} />
        {view.kind === 'chat' && current && (
          <ChatPane key={current.id} agent={current} agents={agents} subscribe={subscribe} onClose={closeView}
            onRename={() => rename(current)} onDelete={() => remove(current)}
            onFork={(to) => setView({ kind: 'chat', id: to })} confirmFork={confirmFork} />
        )}
        {view.kind === 'together' && (
          <Together agents={agents} teams={teams} subscribe={subscribe} onClose={closeView}
            onOpenAgent={(id) => setView({ kind: 'chat', id })} onEditTeam={editTeam} onDeleteTeam={deleteTeam} />
        )}
      </main>
      <footer className="keys"><b>click</b> select · <b>enter</b> send · <b>shift+enter</b> newline · <b>esc</b> close · <b>F11</b> full screen</footer>
      {showUsage && <UsagePanel usage={usage} onClose={() => setShowUsage(false)} />}
      <ModalHost modal={modal} onClose={closeModal}
        onRename={(a, name) => { void api(`/api/agents/${a.id}/rename`, { name }); }} />
    </div>
  );
}

export default function App() {
  return (
    <>
      <div className="bg" aria-hidden="true" />
      <div className="scan" aria-hidden="true" />
      <Startup><Dashboard /></Startup>
    </>
  );
}
