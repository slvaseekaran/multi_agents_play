import { fmtTokens } from './UsagePanel';
import type { Agent } from '../types';
import { LABEL, ago, canDelete, sessInfo } from '../util';

interface Props {
  agents: Agent[]; selected: string | null;
  /** True when no chat is open: the cards use the whole window as a grid. */
  wide: boolean;
  onSelect: (id: string) => void; onRename: (a: Agent) => void; onDelete: (a: Agent) => void;
}

export function AgentList({ agents, selected, wide, onSelect, onRename, onDelete }: Props) {
  return (
    <section className={`list${wide ? ' wide' : ''}`}>
      {agents.map((a) => (
        <div key={a.id} className={`card ${a.status}${a.id === selected ? ' sel' : ''}`} onClick={() => onSelect(a.id)}>
          <div className="card-top">
            <div className="name">{a.name}
              <button className="ghost sm" onClick={(e) => { e.stopPropagation(); onRename(a); }}>edit</button>
            </div>
            <span className={`status ${a.status}`}>{LABEL[a.status]}</span>
          </div>
          {a.title && a.title !== a.name && <div className="meta">{a.title}</div>}
          <div className="meta"><b>session</b> {a.id.slice(0, 8)}{sessInfo(a)}{a.model && <span className="model">{a.model}</span>}{!!a.context && <span className="model" title="Conversation size right now">ctx {fmtTokens(a.context)}</span>}</div>
          <div className="meta"><b>dir</b> {a.cwd || '(unknown)'}</div>
          {a.waitingFor && <div className="meta"><b>waiting for</b> {a.waitingFor}</div>}
          {!!a.duplicates?.length && <div className="dupe">⚠ open in {a.duplicates.length + 1} processes</div>}
          {a.peers.length > 0 && <div className="link">↔ talking with {a.peers.join(', ')}</div>}
          {a.last && <div className="snip">{a.last}</div>}
          <div className="card-foot">
            <span className="meta">{ago(a.lastActivity)}</span>
            {canDelete(a) &&
              <button className="ghost sm danger" onClick={(e) => { e.stopPropagation(); onDelete(a); }}>delete</button>}
          </div>
        </div>
      ))}
    </section>
  );
}
