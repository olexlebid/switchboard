# Stage 0 recon: expected vs actual

Status: **waiting for the output of `scripts/recon.sh`** (and `scripts/recon.sh collect`).
The "Expected" column comes from the spec; "Actual" is filled from the real report.

| # | Topic | Expected (from spec) | Actual | Verdict |
|---|-------|----------------------|--------|---------|
| 1 | `claude` version, `-p` flag | `claude -p` is the headless mode | _pending_ | |
| 2 | `claude -p --output-format json` | JSON with `result` / `is_error` | _pending_ | |
| 3 | `claude -p` permissions | Writes/shell need allow-rules in settings, no full bypass | _pending_ | |
| 4 | statusLine JSON has `rate_limits.five_hour` / `seven_day` | Present for Pro/Max (may vanish in some versions, issue #45133) | _pending_ | |
| 5 | Existing `statusLine` in `~/.claude/settings.json` | Unknown: if present, the hook must wrap it | _pending_ | |
| 6 | `agy` version, `-p` flag | `agy -p` headless | _pending_ | |
| 7 | `agy --output-format json` | Supported | _pending_ | |
| 8 | `agy -p` without TTY | May hang or print empty stdout (issues #318, #76) | _pending_ | |
| 9 | `agy -p` with TTY | Works | _pending_ | |
| 10 | `agy -p` permissions (write / shell) | Sources contradict: auto-approve vs soft block | _pending_ | |
| 11 | `agy models` / `usage` / `quota` subcommands | `/usage` exists only in the TUI | _pending_ | |
| 12 | Rules file read by `agy` | One of `GEMINI.md` / `AGENTS.md` / other | _pending_ | |
| 13 | Limit message samples (claude) | e.g. "usage limit reached", "resets at ..." | _pending_ | |
| 14 | Limit message samples (agy) | Unknown | _pending_ | |

## Discrepancies and decisions for later stages

_To be filled after the report arrives._
