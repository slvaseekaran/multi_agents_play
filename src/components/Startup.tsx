import { useEffect, useState } from 'react';
import { healthy, initBackend, type BackendInfo } from '../api';

/** Waits for the WSL backend (started by the desktop shell) before rendering the dashboard. */
export function Startup({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [info, setInfo] = useState<BackendInfo | null>(null);
  const [tries, setTries] = useState(0);

  useEffect(() => {
    let stop = false;
    (async () => {
      const i = await initBackend().catch((e) => ({ url: '', logPath: '', error: String(e) }));
      if (stop) return;
      setInfo(i);
      for (let n = 0; !stop; n++) {
        if (await healthy()) return setReady(true);
        setTries(n + 1);
        await new Promise((r) => setTimeout(r, 700));
      }
    })();
    return () => { stop = true; };
  }, []);

  if (ready) return <>{children}</>;
  return (
    <div className="empty boot">
      <div>
        starting backend in WSL<span className="cursor">_</span>
        <div className="dim small">{tries > 8 ? 'this is taking longer than usual' : `attempt ${tries}`}</div>
        {info?.error && <div className="note error">{info.error}</div>}
        {tries > 8 && info?.logPath && <div className="dim small">backend log: {info.logPath}</div>}
      </div>
    </div>
  );
}
