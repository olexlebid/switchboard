// Files no agent may change (netlify.toml, .env*, ...): checked after every run, for every agent.

function toRegex(glob: string): RegExp {
  const re = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*');
  return new RegExp(`^${re}$`);
}

/** A pattern without "/" matches the file name at any depth; otherwise it matches the full path. */
export function matchesProtected(file: string, patterns: string[]): boolean {
  const base = file.split('/').pop() ?? file;
  return patterns.some((p) => toRegex(p).test(p.includes('/') ? file : base));
}

export function protectedTouched(files: string[], patterns: string[]): string[] {
  return files.filter((f) => matchesProtected(f, patterns));
}
