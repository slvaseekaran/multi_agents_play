import { useCallback, useEffect, useRef, useState } from 'react';
import { url } from './api';

export interface Attachment { key: string; preview: string; name?: string; error?: string }

/** Image attachments for a message: paste from the clipboard, drop files, or pick them. Uploaded eagerly. */
export function useAttachments() {
  const [items, setItems] = useState<Attachment[]>([]);
  const previews = useRef<string[]>([]);

  const add = useCallback(async (files: File[]) => {
    for (const f of files.filter((x) => x.type.startsWith('image/'))) {
      const key = crypto.randomUUID();
      const preview = URL.createObjectURL(f);
      previews.current.push(preview);
      setItems((cur) => [...cur, { key, preview }]);
      try {
        const r = await fetch(url('/api/uploads'), { method: 'POST', headers: { 'Content-Type': f.type || 'image/png' }, body: f });
        const d = await r.json();
        setItems((cur) => cur.map((i) => (i.key === key ? (r.ok ? { ...i, name: d.name } : { ...i, error: d.error ?? 'upload failed' }) : i)));
      } catch {
        setItems((cur) => cur.map((i) => (i.key === key ? { ...i, error: 'upload failed' } : i)));
      }
    }
  }, []);

  const imagesIn = (dt: DataTransfer): File[] => {
    const fromFiles = [...dt.files].filter((f) => f.type.startsWith('image/'));
    if (fromFiles.length) return fromFiles;
    return [...dt.items].filter((i) => i.kind === 'file' && i.type.startsWith('image/')).map((i) => i.getAsFile()).filter((f): f is File => !!f);
  };
  // Only images are intercepted; pasting text behaves normally.
  const onPaste = (e: React.ClipboardEvent) => { const f = imagesIn(e.clipboardData); if (f.length) { e.preventDefault(); void add(f); } };
  const onDrop = (e: React.DragEvent) => { const f = imagesIn(e.dataTransfer); if (f.length) { e.preventDefault(); void add(f); } };
  const onDragOver = (e: React.DragEvent) => { if ([...e.dataTransfer.types].includes('Files')) e.preventDefault(); };

  const remove = (key: string) => setItems((cur) => cur.filter((i) => i.key !== key));
  const clear = () => setItems([]);
  useEffect(() => () => previews.current.forEach((p) => URL.revokeObjectURL(p)), []);

  return {
    items, add, onPaste, onDrop, onDragOver, remove, clear,
    busy: items.some((i) => !i.name && !i.error),
    names: items.filter((i) => i.name).map((i) => i.name as string),
  };
}
export type Attachments = ReturnType<typeof useAttachments>;

export function AttachBar({ att }: { att: Attachments }) {
  const pick = useRef<HTMLInputElement>(null);
  return (
    <div className="attach-bar">
      {att.items.map((i) => (
        <span key={i.key} className={`thumb${i.error ? ' bad' : ''}`} title={i.error ?? (i.name ? 'attached' : 'uploading…')}>
          <img src={i.preview} alt="attachment" />
          {!i.name && !i.error && <em>…</em>}
          <button type="button" onClick={() => att.remove(i.key)} title="Remove">×</button>
        </span>
      ))}
      <button type="button" className="ghost sm" title="Attach an image (or paste / drop one)" onClick={() => pick.current?.click()}>+ image</button>
      <input ref={pick} type="file" accept="image/*" multiple hidden
        onChange={(e) => { void att.add([...(e.target.files ?? [])]); e.target.value = ''; }} />
    </div>
  );
}
