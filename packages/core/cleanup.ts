// Process-exit cleanup registry: runs registered callbacks (synchronously) on normal exit,
// Ctrl+C, SIGTERM and SIGHUP. Used to stop agent processes and restore temporary settings.

type Entry = { order: number; fn: () => void };
const entries = new Set<Entry>();
let installed = false;

function runAll(): void {
  for (const e of [...entries].sort((a, b) => a.order - b.order)) {
    entries.delete(e);
    try { e.fn(); } catch { /* cleanup must never throw */ }
  }
}

function install(): void {
  if (installed) return;
  installed = true;
  process.on('exit', runAll);
  for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]] as const) {
    try {
      process.on(sig, () => {
        runAll();
        process.exit(code);
      });
    } catch {
      // Signal handlers are unavailable in some worker environments: the exit hook still runs.
    }
  }
}

/** Registers `fn`; lower `order` runs first (0 = stop processes, 1 = restore files). Returns an unregister function. */
export function onExit(fn: () => void, order = 1): () => void {
  install();
  const entry: Entry = { order, fn };
  entries.add(entry);
  return () => { entries.delete(entry); };
}
