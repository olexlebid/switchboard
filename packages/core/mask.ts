// Masking helpers: account labels for the UI and secrets for anything written to logs.

/** "olexlebid@gmail.com" -> "ole…@gmail.com". */
export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at < 1) return '…';
  return `${email.slice(0, Math.min(3, at))}…${email.slice(at)}`;
}

const SECRET_PATTERNS: [RegExp, string][] = [
  [/sk-[A-Za-z0-9_-]{8,}/g, '<token>'],
  [/ya29\.[A-Za-z0-9._-]+/g, '<token>'],
  [/AIza[0-9A-Za-z_-]{20,}/g, '<token>'],
  [/gh[pousr]_[A-Za-z0-9]{20,}/g, '<token>'],
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_.-]+/g, '<jwt>'],
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]+/g, '$1<token>'],
  [/((?:api[_-]?key|secret|password|access[_-]?token|refresh[_-]?token)["'\s:=]+)[^\s"',]{6,}/gi, '$1<redacted>'],
];

/** Removes anything that looks like a secret from text before it is logged or shown. */
export function maskSecrets(text: string): string {
  return SECRET_PATTERNS.reduce((t, [re, repl]) => t.replace(re, repl), text);
}
