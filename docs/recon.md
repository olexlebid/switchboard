# Stage 0 recon: expected vs actual

Round 1 run on macOS (arm64), Node 22.20, `claude` 2.1.286, `agy` 1.2.14.
Manual `/usage` and `/quota` checks and round 2 (`scripts/recon.sh round2`) done on the same machine. **Stage 0 is closed.**

| # | Topic | Expected (from spec) | Actual | Verdict |
|---|-------|----------------------|--------|---------|
| 1 | `claude` headless | `claude -p` | Works. `--output-format json` returns one JSON object with `result`, `is_error`, `total_cost_usd`, `usage`, `modelUsage`, `permission_denials`, `terminal_reason`, `api_error_status` | OK |
| 2 | `claude -p` permissions | Needs allow-rules, no full bypass | Write and shell are **denied by default**; the run still ends with `is_error:false`, `subtype:success`. Denials are listed in `permission_denials`. `--allowedTools` / `--disallowedTools` exist. | Differs: success flag does not mean the task was done. Allow-list test (round 2): `--allowedTools "Write,Edit,Bash(echo *)"` let `Write` through but **denied** `echo SB_SHELL_OK > shell.txt` (a redirect is not matched by `Bash(echo *)`). Allow-rules must be written per concrete command shape |
| 3 | statusLine JSON has `rate_limits` | Present for Pro/Max | **Absent** in 2.1.286 (one probe session, one message). Present instead: `cost`, `context_window`, `model`, `version`, `fast_mode`, ... | **Differs.** Replaced by `claude -p "/usage"` (row 15) |
| 4 | Existing `statusLine` in `~/.claude/settings.json` | Unknown | None configured | OK, hook needs no wrapping on this machine (keep the wrap logic anyway) |
| 5 | `agy` headless | `agy -p` | Works. Flags: `-p/--print`, `--output-format text|json|stream-json`, `--print-timeout`, `--model`, `--sandbox`, `--json-schema`, `--dangerously-skip-permissions` | OK |
| 6 | `agy -p` without TTY | May hang / empty stdout | **No hang**, ~4 s, JSON printed. With a pty it was slower (29 s) and polluted with escape codes | Differs (better): `node-pty` not needed |
| 7 | `agy -p` exit code on failure | Non-zero | Denied write gave **exit 0**, `status: "SUCCESS"`, empty `response`, `denied_actions: [...]`. A human-readable `jetski: no output produced ...` line goes to stderr | **Differs: do not rely on exit code** |
| 8 | `agy -p` permissions | Sources contradict | Write is **auto-denied** in headless. Message suggests `permissions.allow` in `settings.json` (e.g. `write_file(<target>)`) or `--dangerously-skip-permissions`. Shell not tested (stopped at write) | Clarified. Settings file candidate: `~/.gemini/antigravity-cli/settings.json` (keys not inspected yet, stage 3 reads them). `~/.gemini/config/` holds MCP and project configs |
| 9 | `agy` quota command | `/usage` TUI only; maybe a subcommand | `agy usage` / `agy quota` do **not** exist (they print the generic help). `agy models` lists 14 models (Gemini 3.x/3.1 Pro, Claude Sonnet/Opus 4.6, GPT-OSS 120B). Full subcommand list: `agent(s)`, `changelog`, `help`, `install`, `mcp`, `mic-serve`, `models`, `plugin(s)`, `remote-control`, `update` (no usage/quota). Extra flags: `--mode accept-edits|plan`, `--effort`, `--project`, `--continue`, `--conversation`, `--log-file` | Differs |
| 10 | Rules file read by `agy` | GEMINI.md / AGENTS.md / other | **Inconclusive**: the reply was empty because of the write denial. Config dirs found: `~/.gemini`, `~/.antigravity`, `~/Library/Application Support/Antigravity` | Resolved by round 2, see row 18 |
| 11 | Limit message samples, claude | "usage limit", "resets at" | None found (two false hits from Claude Code's own source text) | Still unknown |
| 12 | Limit message samples, agy | Unknown | None found, `~/.gemini` and `~/.antigravity` logs empty | Still unknown |
| 13 | `agy -p` usage numbers | Percentages | `agy -p` JSON has token counts only, but `agy -p "/quota"` prints quota percentages (row 16) | Differs, solved by row 16 |
| 14 | Tooling | pnpm | `pnpm` not installed (Node 22.20 is) | Install before stage 1 (`corepack enable` or `npm i -g pnpm`) |
| 15 | Claude limits via `claude -p "/usage"` | Not in spec (slash commands assumed unavailable in `-p`) | **Works**, prints text, exit 0: `Current session: 2% used · resets Oct 1 at 12:30pm (Europe/Berlin)` and `Current week (all models): 3% used · resets Oct 1 at 9am (Europe/Berlin)`. Integer percent of **used**. Reset time is local wall-clock **without year**, with an IANA zone name. Same numbers as the TUI `/usage` tab | New primary Claude source (`source: "cli"`). To verify in stage 1: does it consume quota / appear in `total_cost_usd` (try `--output-format json`), and which text variants exist (no date when same day, 0% / 100% / limit reached) |
| 16 | agy limits via `agy -p "/quota"` (also `/usage`) | Not in spec | **Works**, prints text, exit 0. Four lines: `<group> <Weekly|Five Hour> Limit Remaining <N>% <ISO UTC reset time>`; columns are separated by tabs or spaces (stage-1 real run showed the screenshot spacing is misleading). Groups: `Gemini Models` (Flash + Pro) and `Claude and GPT models` (Opus, Sonnet, GPT-OSS). Percent is **remaining** and integer-rounded here (TUI showed 99.94 / 99.64), reset is absolute UTC | New primary agy source (`source: "cli"`). Quota is per **group**, not per model: `perModel` becomes `perGroup` |
| 17 | Quota is per model group in agy | Per-model bars | Models inside a group share one weekly and one 5-hour limit; quota is consumed proportionally to token cost (text in the `/quota` TUI) | Dashboard shows 2 groups x 2 bars. Router must know which group a chosen `--model` belongs to |
| 18 | Rules file read by `agy` (round 2, no tools needed) | GEMINI.md / AGENTS.md / other | `GEMINI.md` **yes**, `AGENTS.md` **yes**, `CLAUDE.md` **no**. A global `~/.gemini/GEMINI.md` also exists on this machine and applies to every run | Resolved. `sb init` writes `AGENTS.md` for agy (neutral name), `CLAUDE.md` for claude. Warn if a global `~/.gemini/GEMINI.md` is present |
| 19 | Account type (`claude auth status`) | Pro | `authMethod: claude.ai`, `subscriptionType: pro`, JSON output | OK. This command is a cheap login/plan check for `sb status` |
| 20 | agy permissions: where rules live (rounds 3-4) | Project-level or CLI flag | Project-level `settings.json` files (5 candidate paths), `--mode accept-edits` and `--sandbox` are **all ignored/insufficient**. Rules are read only from the **user-level** `~/.gemini/antigravity-cli/settings.json` (`permissions.allow`). `write_file(*)` works, bare `write_file` does not. Workspace trust (`trustedWorkspaces`) has no effect | Resolved: temporary user-level rule per run |
| 21 | agy shell access (rounds 4-5) | Maybe allowed | Shell action name is `command` (`command(*)` allows). Patterns are strict (`command(echo *)` did not cover `echo ... > file`). **`deny` did NOT stop `rm`** when `command(*)` was allowed | **Shell is never granted to agy**: no reliable deny-list |
| 22 | agy write scoping (rounds 5-7) | Glob patterns | `write_file(<dir>/*)` and `<dir>/**` match **nothing**. A directory prefix **`write_file(<dir>/)`** works: covers nested folders, blocks outside paths and a sibling dir with the same name prefix (`proj2`). `deny` with the same form blocked the subdirectory, but **silently** (no `denied_actions` entry) | Resolved: `write_file({project}/)` for the run; protected-paths check as the safety net |
| 23 | Account type and models | - | `claude auth status`: `subscriptionType: pro`. `agy models` lists 14 models in 2 quota groups | OK |

## Consequences for the design

1. **Claude limits.** Primary source is `claude -p "/usage"` (text parser, `source: cli`). The statusLine hook becomes optional (keep it only as a bonus if a version returns `rate_limits`). `local-logs` estimate stays as the fallback when the text cannot be parsed. Parser must degrade to `unknown`, never throw.
   - **agy limits.** `agy -p "/quota"` text parser, per group, remaining% converted to `usedPct`, ISO reset time used as is. No unofficial endpoint adapter is needed any more; `agy.quotaAdapter: unofficial` can be dropped from the config.
2. **Limit detection.** Exit code is unreliable on both CLIs. Detect by: `is_error` / `api_error_status` (claude), `status` + `denied_actions` + stderr text (agy), plus the configured tail patterns. Real limit-message samples are still missing, so the patterns stay configurable and the first real limit hit must be logged verbatim.
3. **Permissions.** Runner must pass explicit allow-lists (claude: `--allowedTools`; agy: `permissions.allow`), never full bypass. A run with non-empty `permission_denials` / `denied_actions` must be treated as **failed or blocked**, not success.
4. **agy runner.** Plain `child_process.spawn` with `--output-format json` and `--print-timeout`; no `node-pty`.
5. **Models count on the card.** `agy models` gives a real number (14 here).

6. **Permissions are per command shape.** Runner builds the allow-list per task type from config (e.g. claude: `Write`, `Edit`, `Bash(git status)`, `Bash(git diff *)`, `Bash(git add *)`, `Bash(git commit *)`, `Bash(pnpm *)`, `Bash(npm *)`, plus an explicit deny-list). Plain redirects (`> file`) are not covered by `Bash(echo *)`, so tasks should use the Write/Edit tools for files. For agy use `permissions.allow` entries (`write_file(...)`) once the settings schema is read in stage 3.
7. **Rules files.** `sb init` creates `CLAUDE.md` (`@RULES.md`) and `AGENTS.md` (one line: read `RULES.md` and `DESIGN.md`). The prompt preamble also names these files explicitly, so a missing auto-load is not fatal.
8. **Global rule leakage.** `~/.gemini/GEMINI.md` is loaded into every agy run. `sb status` should show a notice if it is non-empty.

## Spec changes accepted for the next stages
- Limits come from `claude -p "/usage"` and `agy -p "/quota"` (text parsers), not from statusLine / unofficial endpoints.
- `UsageSnapshot.perModel` becomes `perGroup` (agy groups: `Gemini Models`, `Claude and GPT models`).
- `agy.quotaAdapter` option is removed from the config; `claude-statusline.mjs` stays optional.
- Limit detection does not trust exit codes; success requires empty `permission_denials` / `denied_actions`.
- No `node-pty`.

## Stage 3 decisions from recon rounds 3-7
- **agy permissions are temporary and directory-scoped.** `sb run --agent agy` backs up `~/.gemini/antigravity-cli/settings.json`, adds `write_file(<real project path>/)` (+ best-effort deny for `.env` and `netlify.toml`), and removes exactly those rules when the run ends. A journal (`~/.switchboard/agy-rules-journal.json`) lets the next run repair a crash; a second concurrent run is refused; Ctrl+C / kill also restore the file.
- **No shell for agy.** Tasks that need `git`/`pnpm`/`astro` should go to Claude (routing: `section`, `copy` already prefer Claude).
- **Protected paths** (`git.protectedPaths`: `netlify.toml`, `.env*`): checked after every run for every agent. A touch makes the run `blocked` and the branch is never pushed. This covers the silent deny.
- **Interrupted runs** (Ctrl+C / kill) leave a `wip(sb): checkpoint <id> interrupted` commit on the task branch and a `failed` task; the project stays on that branch.
- While an agy run is active the same temporary rule also applies to the user's own interactive agy sessions in that project directory.
