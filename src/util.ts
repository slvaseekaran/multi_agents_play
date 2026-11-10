import type { Agent, Control, Status } from './types';

/** Offline and idle agents may be deleted; an idle one is a live terminal that gets closed first. */
export const canDelete = (a: Agent) => (a.status === 'offline' || a.status === 'idle') && a.control !== 'readonly' && !a.managedRun;

export const LABEL: Record<Status, string> = { working: 'Working', idle: 'Idle', waiting: 'Waiting for Input', offline: 'Offline' };
export const MODE: Record<Control, string> = {
  tmux: 'real Claude Code session (tmux): everything you send goes to the actual CLI, /slash commands included',
  managed: 'closed session: send a message or press start to reopen it in the real CLI, same session and full history',
  fork: 'open in a terminal outside tmux: "move here" closes that terminal and continues the SAME session in the dashboard',
  readonly: 'history only (other Claude home)',
};
const TAGS = ['#00ff41', '#ffb000', '#ff3df2', '#ff6a00', '#c6ff00', '#ff2a3d', '#00ffa3'];

export const tagColor = (id: string) => TAGS[[...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % TAGS.length];

export function ago(t: number | null | undefined): string {
  if (!t) return '';
  const s = Math.max(0, (Date.now() - t) / 1000);
  return s < 60 ? 'just now' : s < 3600 ? `${(s / 60) | 0}m ago` : s < 86400 ? `${(s / 3600) | 0}h ago` : `${(s / 86400) | 0}d ago`;
}

export const sessInfo = (a: Agent) =>
  a.status === 'offline' ? '' : ` · pid ${a.pid}${a.tty ? ' · ' + a.tty : ''}${a.tmuxPane ? ' · tmux ' + a.tmuxPane : ''}`;

export const resolveName = (agents: Agent[], n: string) =>
  agents.find((x) => x.origName === n || x.name === n || x.id === n)?.name ?? n;
