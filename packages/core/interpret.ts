// Turns the raw output of a headless agent run into a normalized outcome.
// Exit codes are not trusted: both CLIs report denied tools and many errors with exit code 0.
import type { AgentId } from './types';

export type Outcome = {
  ok: boolean;
  /** Tools/actions that were denied because headless mode cannot ask for permission. */
  denied: string[];
  /** The agent's own final message, truncated. */
  summary?: string;
  /** Machine-readable problem, if any (is_error, api error, bad JSON). */
  error?: string;
};

const MAX_SUMMARY = 2000;

/** Last JSON object found in the text (CLIs may print notices before it). */
export function lastJsonObject(text: string): Record<string, unknown> | undefined {
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('{'));
  for (const line of lines.reverse()) {
    try {
      const v = JSON.parse(line);
      if (v && typeof v === 'object') return v as Record<string, unknown>;
    } catch { /* not a complete JSON line */ }
  }
  try {
    const v = JSON.parse(text.trim());
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

const cut = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, MAX_SUMMARY) : undefined;

export function interpretOutput(agent: AgentId, stdout: string, stderr: string): Outcome {
  const json = lastJsonObject(stdout) ?? lastJsonObject(stderr);
  if (!json) return { ok: false, denied: [], error: 'no JSON result in the agent output' };

  if (agent === 'claude') {
    const denials = Array.isArray(json.permission_denials) ? json.permission_denials : [];
    const denied = denials.map((d) => String((d as { tool_name?: unknown }).tool_name ?? 'unknown'));
    const isError = json.is_error === true;
    const apiStatus = json.api_error_status;
    return {
      ok: !isError && denied.length === 0 && !apiStatus,
      denied: [...new Set(denied)],
      summary: cut(json.result),
      error: isError ? cut(json.result) ?? 'is_error' : apiStatus ? `api error ${String(apiStatus)}` : undefined,
    };
  }

  // agy: {"status":"SUCCESS","response":"...","denied_actions":[{"action":"write_file",...}]}
  const actions = Array.isArray(json.denied_actions) ? json.denied_actions : [];
  const denied = actions.map((a) => String((a as { action?: unknown }).action ?? 'unknown'));
  const status = String(json.status ?? '');
  return {
    ok: status === 'SUCCESS' && denied.length === 0,
    denied: [...new Set(denied)],
    summary: cut(json.response),
    error: status !== 'SUCCESS' ? `status ${status || 'missing'}` : undefined,
  };
}
