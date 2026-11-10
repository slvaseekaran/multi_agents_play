import { Fragment } from 'react';

/** Minimal markdown: code fences, inline code, paragraphs. Renders React nodes (no raw HTML). */
export function Markdown({ text }: { text: string }) {
  return (
    <>
      {text.split('```').map((part, i) =>
        i % 2 ? (
          <pre key={i}><code>{part.replace(/^[^\n]*\n/, '')}</code></pre>
        ) : (
          <Fragment key={i}>
            {part.trim() === '' ? null : part.trim().split(/\n{2,}/).map((p, j) => (
              <p key={j}>
                {p.split(/`([^`]+)`/).map((seg, k) => (k % 2 ? <code key={k}>{seg}</code> : seg.split('\n').flatMap((l, m) => (m ? [<br key={m} />, l] : [l]))))}
              </p>
            ))}
          </Fragment>
        ),
      )}
    </>
  );
}
