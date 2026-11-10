import type { ChatEvent } from './types';

export type Item =
  | { k: 'event'; e: ChatEvent }
  | { k: 'tool'; e: ChatEvent; results: { text: string; error: boolean }[] }
  | { k: 'note'; id: string; text: string; error: boolean };

export function fold(items: Item[], e: ChatEvent): Item[] {
  if (e.role === 'result') {
    return items.map((it) => (it.k === 'tool' && it.e.toolId === e.forId ? { ...it, results: [...it.results, { text: e.text, error: !!e.error }] } : it));
  }
  return [...items, e.role === 'tool' ? { k: 'tool', e, results: [] } : { k: 'event', e }];
}

