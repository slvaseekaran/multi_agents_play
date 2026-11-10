export type Status = 'working' | 'idle' | 'waiting' | 'offline';
export type Control = 'tmux' | 'managed' | 'fork' | 'readonly';

export interface QuestionOption { label: string; description?: string }
export interface Question { question: string; header?: string; options: QuestionOption[]; multiSelect?: boolean }
export interface Permission {
  requestId: string;
  tool: string;
  description: string;
  reason: string;
  input: Record<string, any> & { questions?: Question[] };
  canRemember: boolean;
}

export interface Agent {
  id: string;
  name: string;
  origName: string;
  title: string;
  cwd: string;
  model: string;
  status: Status;
  waitingFor: string;
  pid: number;
  tty: string;
  tmuxPane: string;
  control: Control;
  last: string;
  lastActivity: number | null;
  managedRun: boolean;
  peers: string[];
  permissions?: Permission[];
  conflict?: boolean;
  context?: number;
  isNew?: boolean;
}

/** A named group of agents shown together in an isolated room. */
export interface TeamMember { id: string; name: string }
export interface Team { id: string; name: string; members: TeamMember[] }

export interface ChatEvent {
  id: string;
  ts?: string;
  role: 'user' | 'assistant' | 'tool' | 'result' | 'peer';
  text: string;
  name?: string;
  toolId?: string;
  forId?: string;
  error?: boolean;
  dir?: 'in' | 'out';
  peer?: string;
  file?: string;
  urls?: string[];
}

export interface UsageWindow { utilization: number | null; resetsAt: number }
export interface Usage { windows?: Record<string, UsageWindow>; updatedAt?: number }

export interface ArtifactItem {
  kind: 'artifact' | 'file';
  name: string;
  ts: string;
  url?: string;
  path?: string;
  winPath?: string;
}

export type LiveMsg =
  | { type: 'messages'; id: string; events: ChatEvent[] }
  | { type: 'note'; id: string; level: string; text: string }
  | { type: 'fork'; from: string; to: string };

