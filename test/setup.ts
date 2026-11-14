// Tests must never read the real ~/.codex session logs (the ChatGPT limits adapter looks there).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.CODEX_HOME = mkdtempSync(join(tmpdir(), 'sb-codex-home-'));
