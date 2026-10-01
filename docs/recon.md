# Stage 0 recon: expected vs actual

Round 1 run on macOS (arm64), Node 22.20, `claude` 2.1.286, `agy` 1.2.14.
Round 2 (`scripts/recon.sh round2`) is pending; rows marked **R2** depend on it.

| # | Topic | Expected (from spec) | Actual | Verdict |
|---|-------|----------------------|--------|---------|
| 1 | `claude` headless | `claude -p` | Works. `--output-format json` returns one JSON object with `result`, `is_error`, `total_cost_usd`, `usage`, `modelUsage`, `permission_denials`, `terminal_reason`, `api_error_status` | OK |
| 2 | `claude -p` permissions | Needs allow-rules, no full bypass | Write and shell are **denied by default**; the run still ends with `is_error:false`, `subtype:success`. Denials are listed in `permission_denials`. `--allowedTools` / `--disallowedTools` exist. | Differs: success flag does not mean the task was done. Allow-list test is **R2** |
| 3 | statusLine JSON has `rate_limits` | Present for Pro/Max | **Absent** in 2.1.286 (one probe session, one message). Present instead: `cost`, `context_window`, `model`, `version`, `fast_mode`, ... | **Differs: primary Claude source unavailable** |
| 4 | Existing `statusLine` in `~/.claude/settings.json` | Unknown | None configured | OK, hook needs no wrapping on this machine (keep the wrap logic anyway) |
| 5 | `agy` headless | `agy -p` | Works. Flags: `-p/--print`, `--output-format text|json|stream-json`, `--print-timeout`, `--model`, `--sandbox`, `--json-schema`, `--dangerously-skip-permissions` | OK |
| 6 | `agy -p` without TTY | May hang / empty stdout | **No hang**, ~4 s, JSON printed. With a pty it was slower (29 s) and polluted with escape codes | Differs (better): `node-pty` not needed |
| 7 | `agy -p` exit code on failure | Non-zero | Denied write gave **exit 0**, `status: "SUCCESS"`, empty `response`, `denied_actions: [...]`. A human-readable `jetski: no output produced ...` line goes to stderr | **Differs: do not rely on exit code** |
| 8 | `agy -p` permissions | Sources contradict | Write is **auto-denied** in headless. Message suggests `permissions.allow` in `settings.json` (e.g. `write_file(<target>)`) or `--dangerously-skip-permissions`. Shell not tested (stopped at write) | Clarified. Where `settings.json` lives: **R2** |
| 9 | `agy` quota command | `/usage` TUI only; maybe a subcommand | `agy usage` / `agy quota` do **not** exist (they print the generic help). `agy models` lists 14 models (Gemini 3.x/3.1 Pro, Claude Sonnet/Opus 4.6, GPT-OSS 120B). Full subcommand list: **R2** | Differs |
| 10 | Rules file read by `agy` | GEMINI.md / AGENTS.md / other | **Inconclusive**: the reply was empty because of the write denial. Config dirs found: `~/.gemini`, `~/.antigravity`, `~/Library/Application Support/Antigravity` | Retest in **R2** |
| 11 | Limit message samples, claude | "usage limit", "resets at" | None found (two false hits from Claude Code's own source text) | Still unknown |
| 12 | Limit message samples, agy | Unknown | None found, `~/.gemini` and `~/.antigravity` logs empty | Still unknown |
| 13 | `agy -p` usage numbers | Percentages | JSON has token counts only (`usage.input_tokens`, ...), no quota percentages | Differs |
| 14 | Tooling | pnpm | `pnpm` not installed (Node 22.20 is) | Install before stage 1 (`corepack enable` or `npm i -g pnpm`) |

## Consequences for the design

1. **Claude limits.** Without `rate_limits` the statusLine hook is only a bonus source: keep it (cheap, picks the field up if a version returns it) but `claude` status falls back to `local-logs` estimate + `reactive`. Check whether `/usage` in the interactive TUI exposes numbers (manual step in the round-2 message).
2. **Limit detection.** Exit code is unreliable on both CLIs. Detect by: `is_error` / `api_error_status` (claude), `status` + `denied_actions` + stderr text (agy), plus the configured tail patterns. Real limit-message samples are still missing, so the patterns stay configurable and the first real limit hit must be logged verbatim.
3. **Permissions.** Runner must pass explicit allow-lists (claude: `--allowedTools`; agy: `permissions.allow`), never full bypass. A run with non-empty `permission_denials` / `denied_actions` must be treated as **failed or blocked**, not success.
4. **agy runner.** Plain `child_process.spawn` with `--output-format json` and `--print-timeout`; no `node-pty`.
5. **Models count on the card.** `agy models` gives a real number (14 here).
