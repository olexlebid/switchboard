// The bearer token of the public API (`sb api`). Kept in a 0600 file next to the state, or in SB_API_TOKEN.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { sbHome } from './store';

export const tokenPath = (): string => join(sbHome(), 'api-token');

/** The configured token, or undefined when none exists yet. */
export function readApiToken(): string | undefined {
  const fromEnv = process.env.SB_API_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  try {
    const t = readFileSync(tokenPath(), 'utf8').trim();
    return t || undefined;
  } catch {
    return undefined;
  }
}

/** Creates a token (or replaces it with `rotate`). Returns the new token, or undefined when one already exists. */
export function createApiToken(opts: { rotate?: boolean } = {}): string | undefined {
  if (existsSync(tokenPath()) && !opts.rotate) return undefined;
  const token = `sbk_${randomBytes(32).toString('base64url')}`;
  mkdirSync(dirname(tokenPath()), { recursive: true, mode: 0o700 });
  writeFileSync(tokenPath(), `${token}\n`, { mode: 0o600 });
  chmodSync(tokenPath(), 0o600);
  return token;
}

/** Constant-time comparison; a missing or differently sized value never matches. */
export function tokenMatches(given: string | undefined, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
