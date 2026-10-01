// Child process for the concurrency test: increments a counter in state.json many times.
import { updateState } from '../../packages/core/store';

const n = Number(process.argv[2] ?? 30);
for (let i = 0; i < n; i++) {
  updateState((s) => {
    const meta = s.meta as Record<string, unknown>;
    meta.counter = ((meta.counter as number | undefined) ?? 0) + 1;
  });
}
