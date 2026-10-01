// Client hooks: polling of /api/state, a ticking clock and a localStorage-backed value.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DashboardState } from '@core/dashboard-state';

const POLL_IDLE_MS = 30_000;
const POLL_BUSY_MS = 3_000;

/** Polls /api/state; faster while a task or a chat turn runs. `reload` fetches immediately. */
export function useDashboard() {
  const [state, setState] = useState<DashboardState>();
  const [offline, setOffline] = useState(false);
  const busyRef = useRef(false);
  const timer = useRef<number>(undefined);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/state', { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      const next = (await res.json()) as DashboardState;
      busyRef.current = next.busy;
      setState(next);
      setOffline(false);
    } catch {
      setOffline(true);
    }
  }, []);

  useEffect(() => {
    let stopped = false;
    const loop = async () => {
      if (!document.hidden) await load();
      if (!stopped) timer.current = window.setTimeout(loop, busyRef.current ? POLL_BUSY_MS : POLL_IDLE_MS);
    };
    void loop();
    const onVisible = () => { if (!document.hidden) void load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      window.clearTimeout(timer.current);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load]);

  return { state, offline, reload: load };
}

/** Current time, refreshed every `ms` (countdowns and elapsed times). */
export function useNow(ms = 15_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(id);
  }, [ms]);
  return now;
}

/** A string kept in localStorage (per-viewer convenience: selected project, theme). Works without storage. */
export function useStoredString(key: string): [string | undefined, (v: string) => void] {
  const [value, setValue] = useState<string | undefined>(() => {
    try {
      return localStorage.getItem(key) ?? undefined;
    } catch {
      return undefined;
    }
  });
  const set = useCallback((v: string) => {
    setValue(v);
    try {
      localStorage.setItem(key, v);
    } catch { /* storage unavailable: the value just is not remembered */ }
  }, [key]);
  return [value, set];
}
