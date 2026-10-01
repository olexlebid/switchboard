// Browser-side helper for the dashboard's POST endpoints (multipart, so files can travel along).
export type ActionResult = { ok: boolean; message?: string; error?: string; chatId?: string };

export async function post(url: string, data: Record<string, string | undefined>, files: File[] = []): Promise<ActionResult> {
  const body = new FormData();
  for (const [k, v] of Object.entries(data)) if (v !== undefined) body.set(k, v);
  for (const f of files) body.append('files', f);
  try {
    const res = await fetch(url, { method: 'POST', body, headers: { accept: 'application/json' } });
    const payload = (await res.json().catch(() => undefined)) as Partial<ActionResult> | undefined;
    if (!res.ok) return { ok: false, error: payload?.error ?? `Помилка ${res.status}` };
    return { ok: true, ...payload };
  } catch {
    return { ok: false, error: 'Немає зв’язку із сервером Switchboard.' };
  }
}
