// Starts the Astro dashboard (apps/dashboard) bound to 127.0.0.1 only.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultConfigPath } from './config';

const DASH_DIR = fileURLToPath(new URL('../../apps/dashboard', import.meta.url));
const HOST = '127.0.0.1';

/** Finds the astro CLI entry file inside the dashboard package. */
function astroBin(): string {
  const require = createRequire(join(DASH_DIR, 'package.json'));
  let pkgPath: string;
  try {
    pkgPath = require.resolve('astro/package.json');
  } catch {
    throw new Error('Astro не встановлено. Виконай `pnpm install` у корені репозиторію.');
  }
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { bin?: string | Record<string, string> };
  const rel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.astro;
  if (!rel) throw new Error('Не знайшов CLI astro у пакеті astro.');
  return join(dirname(pkgPath), rel);
}

/** dev (default): hot reload, handy for restyling. prod: build once and run the standalone server. */
export function runDashboard(opts: { prod?: boolean; port?: number } = {}): Promise<number> {
  const port = opts.port ?? 4321;
  const bin = astroBin();
  // The bundled server does not know the repo layout: tell it where the config is.
  const env = { ...process.env, SB_CONFIG: defaultConfigPath(), HOST, PORT: String(port) };

  let cmd: string[];
  if (opts.prod) {
    const build = spawnSync(process.execPath, [bin, 'build'], { cwd: DASH_DIR, stdio: 'inherit', env });
    if (build.status !== 0) return Promise.resolve(build.status ?? 1);
    const entry = join(DASH_DIR, 'dist/server/entry.mjs');
    if (!existsSync(entry)) throw new Error(`Після збірки не знайдено ${entry}`);
    cmd = [entry];
  } else {
    cmd = [bin, 'dev', '--host', HOST, '--port', String(port)];
  }

  console.log(`Дешборд: http://${HOST}:${port}  (Ctrl+C щоб зупинити)`);
  const child = spawn(process.execPath, cmd, { cwd: DASH_DIR, stdio: 'inherit', env });
  const stop = () => child.kill('SIGTERM');
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  return new Promise((resolve) => child.on('close', (code) => resolve(code ?? 0)));
}
