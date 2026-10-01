#!/usr/bin/env bash
# Switchboard stage-0 recon.
#
# Collects facts about the local `claude` and `agy` CLIs into one masked text
# report. Everything runs inside throw-away temp directories. It never touches
# ~/.claude, never uses --dangerously-skip-permissions / --yolo style flags and
# sends only a few tiny prompts (a few requests in total).
#
# Usage:
#   scripts/recon.sh            # main recon, writes sb-recon-<time>.txt
#   scripts/recon.sh collect    # after the manual statusLine probe (see output)
#   scripts/recon.sh round2     # follow-up probes (agy rules file, permissions, config dirs)
#   scripts/recon.sh round3     # agy headless permission mechanisms (10 small requests)
#   scripts/recon.sh round4     # agy user-level permissions.allow + workspace trust (temporarily edits, then restores, agy settings)
#   scripts/recon.sh round5     # agy rule scoping (path patterns, command patterns, deny precedence); same temporary edit + restore
#
# Compatible with bash 3.2 (macOS) and GNU bash.

set -u

START_DIR="$(pwd)"
STAMP="$(date +%Y%m%d-%H%M%S)"
PROBE_DIR="${TMPDIR:-/tmp}/sb-recon-probe"
TIMEOUT_SECS="${SB_RECON_TIMEOUT:-120}"
# Keep the original stdin (a TTY when run from a terminal) for the TTY test.
exec 3<&0

# ---------------------------------------------------------------- helpers

# Mask emails, tokens and the home directory in whatever flows through stdin.
mask() {
  sed -E \
    -e 's/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/<email>/g' \
    -e 's/sk-[A-Za-z0-9_-]{8,}/<token>/g' \
    -e 's/ya29\.[A-Za-z0-9._-]+/<token>/g' \
    -e 's/AIza[0-9A-Za-z_-]{20,}/<token>/g' \
    -e 's/gh[pousr]_[A-Za-z0-9]{20,}/<token>/g' \
    -e 's/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_.-]+/<jwt>/g' \
    -e 's/(Bearer )[A-Za-z0-9._~+\/=-]+/\1<token>/g' \
    -e 's/([Tt]oken|[Ss]ecret|[Pp]assword|[Aa]pi[_-]?[Kk]ey)(["'"'"' :=]+)[^ "'"'"',]{6,}/\1\2<redacted>/g' \
    -e "s|${HOME}|~|g"
}

# run_to <secs> <outfile> <cmd...>: run with a timeout, output to file, sets RC.
# RC 124 means the command was killed by the timeout.
run_to() {
  local secs=$1 out=$2
  shift 2
  local marker="${out}.timeout"
  rm -f "$marker"
  if [ "${USE_TTY_STDIN:-0}" = 1 ]; then
    "$@" >"$out" 2>&1 <&3 &
  else
    "$@" >"$out" 2>&1 </dev/null &
  fi
  local pid=$!
  ( sleep "$secs"; touch "$marker"; kill -TERM "$pid" 2>/dev/null; sleep 2; kill -KILL "$pid" 2>/dev/null ) &
  local wd=$!
  wait "$pid" 2>/dev/null
  RC=$?
  kill "$wd" 2>/dev/null
  wait "$wd" 2>/dev/null
  if [ -f "$marker" ]; then
    RC=124
    rm -f "$marker"
  fi
}

# Run a command under a pseudo-terminal. `script` differs between macOS and Linux.
with_pty() {
  if [ "$(uname)" = "Darwin" ]; then
    script -q /dev/null "$@"
  else
    script -qec "$(printf '%q ' "$@")" /dev/null
  fi
}

REPORT="$START_DIR/sb-recon-$STAMP.txt"
say() { printf '%s\n' "$*" >>"$REPORT"; }
head_() { printf '\n==== %s ====\n' "$*" >>"$REPORT"; }
# Append a file (or its first N lines) to the report, indented.
dump() { # dump <file> [max_lines]
  local f=$1 n=${2:-60}
  if [ -s "$f" ]; then head -n "$n" "$f" | sed 's/^/    /' >>"$REPORT"; else say "    (empty)"; fi
}

json_keys() { # print top-level shape of a JSON file
  node -e '
    const fs = require("fs");
    try {
      const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const o = Array.isArray(j)
        ? { array_len: j.length, first_keys: Object.keys(j[0] || {}) }
        : { keys: Object.keys(j), is_error: j.is_error, subtype: j.subtype,
            result_preview: String(j.result || "").slice(0, 200) };
      console.log(JSON.stringify(o, null, 2));
    } catch (e) { console.log("not valid JSON: " + e.message); }
  ' "$1" 2>&1
}

# ---------------------------------------------------------------- collect mode

if [ "${1:-}" = "collect" ]; then
  OUT="$START_DIR/sb-recon-statusline-$STAMP.txt"
  REPORT="$OUT"
  head_ "statusLine probe result"
  DUMP="$PROBE_DIR/dump.json"
  if [ ! -f "$DUMP" ]; then
    say "NO DUMP FOUND at $DUMP: the statusLine hook did not fire (or you did not send a message)."
  else
    node -e '
      const fs = require("fs");
      const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      // Print only the shape (types), never values, except rate_limits.
      const shape = (v, d = 0) =>
        v && typeof v === "object" && !Array.isArray(v) && d < 3
          ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x, d + 1)]))
          : Array.isArray(v) ? "array" : typeof v;
      console.log("top-level shape:", JSON.stringify(shape(j), null, 2));
      console.log("rate_limits present:", "rate_limits" in j);
      if (j.rate_limits) console.log("rate_limits:", JSON.stringify(j.rate_limits, null, 2));
    ' "$DUMP" 2>&1 >>"$REPORT"
  fi
  mask <"$REPORT" >"$REPORT.tmp" && mv "$REPORT.tmp" "$REPORT"
  echo "Done. Review and send: $REPORT"
  exit 0
fi

# ---------------------------------------------------------------- round2 mode

if [ "${1:-}" = "round2" ]; then
  REPORT="$START_DIR/sb-recon-round2-$STAMP.txt"
  WORK="$(mktemp -d "${TMPDIR:-/tmp}/sb-recon2.XXXXXX")"
  finalize() { rm -rf "$WORK"; [ -f "$REPORT" ] && mask <"$REPORT" >"$REPORT.tmp" && mv "$REPORT.tmp" "$REPORT"; }
  trap finalize EXIT
  trap 'exit 130' INT TERM
  say "Switchboard recon round 2 $STAMP"

  head_ "R1. agy full --help and install --help (subcommands, settings hints)"
  if command -v agy >/dev/null 2>&1; then
    run_to 30 "$WORK/agy.help" agy --help;         say "agy --help exit $RC";         dump "$WORK/agy.help" 90
    run_to 30 "$WORK/agy.inst" agy install --help; say "agy install --help exit $RC"; dump "$WORK/agy.inst" 30
  else
    say "SKIPPED: agy not installed"
  fi

  head_ "R2. Config dirs of agy (names only, depth 3, no file contents except JSON key names)"
  for d in "$HOME/.gemini" "$HOME/.antigravity" "$HOME/Library/Application Support/Antigravity"; do
    [ -d "$d" ] || continue
    say "-- $d"
    find "$d" -maxdepth 3 \( -name 'node_modules' -o -name 'Cache*' -o -name 'logs' -o -name 'History' \) -prune -o \
      \( -name '*.json' -o -name '*.md' -o -name '*.toml' -o -name '*.yaml' -o -name '*.yml' \) -type f -print 2>/dev/null \
      | head -n 40 | sed 's/^/    /' >>"$REPORT"
    for f in "$d/settings.json" "$d/config.json" "$d/permissions.json"; do
      [ -f "$f" ] && node -e '
        try { const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
              console.log("    keys of " + process.argv[1] + ": " + JSON.stringify(Object.keys(j))); }
        catch (e) { console.log("    " + process.argv[1] + ": not JSON"); }' "$f" >>"$REPORT" 2>&1
    done
  done

  head_ "R3. agy rules-file probe (no tools needed; one file per dir)"
  if command -v agy >/dev/null 2>&1; then
    for F in GEMINI.md AGENTS.md CLAUDE.md; do
      D="$WORK/rules-$F"; mkdir -p "$D"; cd "$D" || exit 1
      TOKEN="SB_$(echo "${F%.md}" | tr a-z A-Z)_RULE"
      echo "Project rule: always include the exact token $TOKEN in your final reply." >"$F"
      run_to 120 "$WORK/rules.$F.out" agy -p 'Do not use any tools. Reply with the exact token(s) that the project rules tell you to include, or the single word NONE.' --output-format json --print-timeout 90s
      say "[$F] exit $RC; marker $TOKEN seen in reply: $(grep -q "$TOKEN" "$WORK/rules.$F.out" && echo YES || echo no)"
      dump "$WORK/rules.$F.out" 6
      cd "$START_DIR" || exit 1
    done
  else
    say "SKIPPED: agy not installed"
  fi

  head_ "R4. claude -p with explicit allow-list (no bypass)"
  if command -v claude >/dev/null 2>&1; then
    D="$WORK/claude-allow"; mkdir -p "$D"; cd "$D" || exit 1
    run_to 120 "$WORK/claude.allow.out" claude -p 'Create a file named hello.txt containing hi, then run: echo SB_SHELL_OK > shell.txt . Reply with the word done.' --output-format json --allowedTools "Write,Edit,Bash(echo *)"
    say "exit $RC"
    say "hello.txt created: $([ -f hello.txt ] && echo yes || echo no)"
    say "shell.txt created: $([ -f shell.txt ] && echo yes || echo no)"
    node -e '
      try { const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
            console.log("    is_error=" + j.is_error + " denials=" + JSON.stringify((j.permission_denials || []).map(d => d.tool_name))); }
      catch (e) { console.log("    not JSON"); }' "$WORK/claude.allow.out" >>"$REPORT" 2>&1
    cd "$START_DIR" || exit 1
    head_ "R5. claude auth status (email is masked)"
    run_to 30 "$WORK/claude.auth" claude auth status; say "exit $RC"; dump "$WORK/claude.auth" 15
  else
    say "SKIPPED: claude not installed"
  fi

  echo "Done. Review and send: $REPORT"
  exit 0
fi

# ---------------------------------------------------------------- round3 mode

if [ "${1:-}" = "round3" ]; then
  REPORT="$START_DIR/sb-recon-round3-$STAMP.txt"
  WORK="$(mktemp -d "${TMPDIR:-/tmp}/sb-recon3.XXXXXX")"
  finalize() { rm -rf "$WORK"; [ -f "$REPORT" ] && mask <"$REPORT" >"$REPORT.tmp" && mv "$REPORT.tmp" "$REPORT"; }
  trap finalize EXIT
  trap 'exit 130' INT TERM
  say "Switchboard recon round 3 (agy headless permissions) $STAMP"
  command -v agy >/dev/null 2>&1 || { say "agy not installed"; echo "Done. Review and send: $REPORT"; exit 0; }

  head_ "P1. Keys of agy settings files (key names only; values only inside a 'permissions' object)"
  for f in "$HOME/.gemini/antigravity-cli/settings.json" "$HOME/.gemini/settings.json"; do
    [ -f "$f" ] || continue
    say "-- $f"
    node -e '
      const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      const walk = (o, d, pre) => Object.entries(o).forEach(([k, v]) => {
        if (k === "permissions") { console.log("    " + pre + k + " = " + JSON.stringify(v)); return; }
        if (v && typeof v === "object" && !Array.isArray(v) && d < 2) { console.log("    " + pre + k + ": {...}"); walk(v, d + 1, pre + k + "."); }
        else console.log("    " + pre + k + ": " + (Array.isArray(v) ? "array(" + v.length + ")" : typeof v));
      });
      walk(j, 0, "");' "$f" >>"$REPORT" 2>&1
  done

  PROMPT='Do exactly two things. 1) Create a file named hello.txt containing the word hi. 2) Run the shell command: echo SB_SHELL_OK > shell.txt . Then reply with one short sentence.'
  # probe <label> <dir-setup-fn> <extra agy flags...>
  probe() {
    local label=$1 setup=$2; shift 2
    local d="$WORK/$label"; mkdir -p "$d"; cd "$d" || return
    $setup "$d"
    run_to 150 "$WORK/$label.out" agy -p "$PROMPT" --output-format json --print-timeout 120s "$@"
    local denied
    denied="$(grep -o '"denied_actions":\[[^]]*\]' "$WORK/$label.out" | head -1 | cut -c1-160)"
    say "[$label] exit $RC | hello.txt: $([ -f hello.txt ] && echo yes || echo no) | shell.txt: $([ -f shell.txt ] && echo yes || echo no) | ${denied:-no denied_actions field}"
    cd "$START_DIR" || return
  }
  nosetup() { :; }
  project_settings() { # $1 = dir; $JSON_PATH = relative settings file to create
    mkdir -p "$1/$(dirname "$JSON_PATH")"
    echo '{"permissions":{"allow":["write_file(*)","run_command(echo *)"]}}' >"$1/$JSON_PATH"
  }

  head_ "P2. Flags that might allow edits without a full bypass"
  probe baseline nosetup
  probe accept_edits nosetup --mode accept-edits
  probe accept_edits_sandbox nosetup --mode accept-edits --sandbox

  head_ "P3. Project-level settings.json candidates with permissions.allow (write_file, run_command)"
  for JSON_PATH in ".gemini/settings.json" ".agy/settings.json" ".antigravity/settings.json" ".antigravity-cli/settings.json" ".gemini/antigravity-cli/settings.json"; do
    export JSON_PATH
    probe "proj_$(echo "$JSON_PATH" | tr '/.' '__')" project_settings
  done

  say ""
  say "Notes: hello.txt = file writes work, shell.txt = shell commands work. Nothing here uses --dangerously-skip-permissions."
  echo "Done. Review and send: $REPORT"
  exit 0
fi

# ---------------------------------------------------------------- round4 mode

# Tests whether a user-level permissions.allow rule and/or a trusted workspace lets `agy -p`
# write files. It TEMPORARILY edits ~/.gemini/antigravity-cli/settings.json: the original is
# backed up first and restored (and verified byte-for-byte) when the script ends, even on Ctrl+C.
if [ "${1:-}" = "round4" ] || [ "${1:-}" = "round5" ]; then
  ROUND="$1"
  REPORT="$START_DIR/sb-recon-$ROUND-$STAMP.txt"
  WORK="$(mktemp -d "${TMPDIR:-/tmp}/sb-recon4.XXXXXX")"
  SETTINGS="$HOME/.gemini/antigravity-cli/settings.json"
  BACKUP="$SETTINGS.sb-backup-$STAMP"
  RESTORED=0
  restore_settings() {
    [ "$RESTORED" = 1 ] && return
    RESTORED=1
    if [ -f "$BACKUP" ]; then
      cp -p "$BACKUP" "$SETTINGS"
      if cmp -s "$BACKUP" "$SETTINGS"; then
        say ""; say "Settings restored byte-for-byte from the backup (backup kept at $BACKUP)."
        echo "agy settings restored."
      else
        echo "WARNING: could not verify the restore. Copy $BACKUP back to $SETTINGS manually."
        say "WARNING: restore not verified. Backup at $BACKUP"
      fi
    fi
  }
  finalize() { restore_settings; rm -rf "$WORK"; [ -f "$REPORT" ] && mask <"$REPORT" >"$REPORT.tmp" && mv "$REPORT.tmp" "$REPORT"; }
  trap finalize EXIT
  trap 'exit 130' INT TERM

  say "Switchboard recon $ROUND (agy user-level permissions) $STAMP"
  command -v agy >/dev/null 2>&1 || { say "agy not installed"; echo "Done. Review and send: $REPORT"; exit 0; }
  [ -f "$SETTINGS" ] || { say "No $SETTINGS: nothing to test"; echo "Done. Review and send: $REPORT"; exit 0; }
  cp -p "$SETTINGS" "$BACKUP"
  say "Backup of settings: $BACKUP"

  head_ "Q0. Shape of trustedWorkspaces (types only)"
  node -e '
    const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const t = j.trustedWorkspaces;
    console.log("    trustedWorkspaces: " + (Array.isArray(t) ? "array(" + t.length + ") element types: " + JSON.stringify(t.map((x) => typeof x)) : typeof t));
  ' "$SETTINGS" >>"$REPORT" 2>&1

  # apply_settings <allow-json-array|""> <trust-dir|"">: start from the original, merge, write.
  apply_settings() {
    ALLOW="$1" TRUST="$2" PERMS="${PERMS:-}" ORIG="$BACKUP" OUT="$SETTINGS" node -e '
      const fs = require("fs");
      const j = JSON.parse(fs.readFileSync(process.env.ORIG, "utf8"));
      if (process.env.ALLOW) {
        j.permissions = j.permissions || {};
        j.permissions.allow = [...(j.permissions.allow || []), ...JSON.parse(process.env.ALLOW)];
      }
      if (process.env.PERMS) {
        const p = JSON.parse(process.env.PERMS);
        j.permissions = j.permissions || {};
        for (const k of Object.keys(p)) j.permissions[k] = [...(j.permissions[k] || []), ...p[k]];
      }
      if (process.env.TRUST) {
        const t = Array.isArray(j.trustedWorkspaces) ? j.trustedWorkspaces : [];
        if (t.every((x) => typeof x === "string")) j.trustedWorkspaces = [...t, process.env.TRUST];
        else { console.error("trustedWorkspaces has non-string elements: not touched"); }
      }
      fs.writeFileSync(process.env.OUT, JSON.stringify(j, null, 2));
    ' 2>>"$REPORT"
  }

  WRITE_PROMPT='Create a file named hello.txt containing the word hi. Reply with one short sentence.'
  SHELL_PROMPT='Run the shell command: echo SB_SHELL_OK > shell.txt . Reply with one short sentence.'
  # probe <label> <prompt> <allow|""> <trust yes|no> [agy flags...]
  probe() {
    local label=$1 prompt=$2 allow=$3 trust=$4; shift 4
    local d="$WORK/$label"; mkdir -p "$d"; cd "$d" || return
    d="$(pwd -P)"
    if [ "$trust" = yes ]; then apply_settings "$allow" "$d"; else apply_settings "$allow" ""; fi
    run_to 150 "$WORK/$label.out" agy -p "$prompt" --output-format json --print-timeout 120s "$@"
    local denied
    denied="$(grep -o '"denied_actions":\[[^]]*\]' "$WORK/$label.out" | head -1 | cut -c1-160)"
    say "[$label] allow=${allow:-none} trusted=$trust ${*:+flags=$* }-> exit $RC | hello.txt: $([ -f hello.txt ] && echo yes || echo no) | shell.txt: $([ -f shell.txt ] && echo yes || echo no) | ${denied:-no denied_actions}"
    cd "$START_DIR" || return
  }

  if [ "$ROUND" = "round4" ]; then
    head_ "Q1. Which action name does a shell command use? (untrusted, no rules)"
    probe shell_baseline "$SHELL_PROMPT" "" no

    head_ "Q2. Workspace trust and rules, write only"
    probe trust_only "$WRITE_PROMPT" "" yes
    probe trust_accept_edits "$WRITE_PROMPT" "" yes --mode accept-edits
    probe allow_untrusted "$WRITE_PROMPT" '["write_file(*)"]' no
    probe allow_trusted "$WRITE_PROMPT" '["write_file(*)"]' yes
    probe allow_bare_trusted "$WRITE_PROMPT" '["write_file"]' yes

    head_ "Q3. Shell command with a rule (action name taken from Q1)"
    SHELL_ACTION="$(grep -o '"action":"[^"]*"' "$WORK/shell_baseline.out" | head -1 | cut -d'"' -f4)"
    say "shell action name from Q1: ${SHELL_ACTION:-unknown}"
    if [ -n "$SHELL_ACTION" ]; then
      probe shell_allow_trusted "$SHELL_PROMPT" "[\"${SHELL_ACTION}(*)\"]" yes
    fi

  else
    # ---- round 5: how far can the rules be narrowed?
    # Layout: $WORK/proj is the "project" (agy runs with it as cwd), $WORK/other is outside it.
    PROJ="$WORK/proj"; OTHER="$WORK/other"; mkdir -p "$PROJ/sub" "$OTHER"; PROJ="$(cd "$PROJ" && pwd -P)"; OTHER="$(cd "$OTHER" && pwd -P)"
    # probe5 <label> <perms-json> <prompt> <files-to-check...>
    probe5() {
      local label=$1 perms=$2 prompt=$3; shift 3
      cd "$PROJ" || return
      rm -f "$PROJ"/hello.txt "$PROJ"/shell.txt "$PROJ"/sub/nested.txt "$OTHER"/outside.txt
      echo keep >"$PROJ/victim.txt"
      PERMS="$perms" apply_settings "" ""
      run_to 150 "$WORK/$label.out" agy -p "$prompt" --output-format json --print-timeout 120s
      local denied res=""
      denied="$(grep -o '"denied_actions":\[[^]]*\]' "$WORK/$label.out" | head -1 | cut -c1-200)"
      for f in "$@"; do res="$res $(basename "$f"): $([ -f "$f" ] && echo present || echo absent);"; done
      say "[$label] perms=$perms ->$res | ${denied:-no denied_actions}"
      cd "$START_DIR" || return
    }

    head_ "S1. Path-scoped write rules (project = $PROJ)"
    probe5 scope_star_inside "{\"allow\":[\"write_file($PROJ/*)\"]}" "Create the file $PROJ/hello.txt containing hi. Reply briefly." "$PROJ/hello.txt"
    probe5 scope_star_outside "{\"allow\":[\"write_file($PROJ/*)\"]}" "Create the file $OTHER/outside.txt containing hi. Reply briefly." "$OTHER/outside.txt"
    probe5 scope_star_nested "{\"allow\":[\"write_file($PROJ/*)\"]}" "Create the file $PROJ/sub/nested.txt containing hi. Reply briefly." "$PROJ/sub/nested.txt"
    probe5 scope_dstar_nested "{\"allow\":[\"write_file($PROJ/**)\"]}" "Create the file $PROJ/sub/nested.txt containing hi. Reply briefly." "$PROJ/sub/nested.txt"

    head_ "S2. Shell command patterns and deny precedence"
    probe5 cmd_echo_only_allowed "{\"allow\":[\"command(echo *)\"]}" "Run exactly this shell command: echo SB_SHELL_OK > $PROJ/shell.txt . Reply briefly." "$PROJ/shell.txt"
    probe5 cmd_echo_only_rm "{\"allow\":[\"command(echo *)\"]}" "Run exactly this shell command: rm $PROJ/victim.txt . Reply briefly." "$PROJ/victim.txt"
    probe5 cmd_deny_rm "{\"allow\":[\"command(*)\"],\"deny\":[\"command(rm *)\"]}" "Run exactly this shell command: rm $PROJ/victim.txt . Reply briefly." "$PROJ/victim.txt"
  fi

  say ""
  say "Notes: nothing here used --dangerously-skip-permissions. The original settings file is restored at the end."
  echo "Done. Review and send: $REPORT"
  exit 0
fi

# ---------------------------------------------------------------- main recon

say "Switchboard recon $STAMP"
say "Review this file before sending it. Emails/tokens/home path are masked, but check anyway."

head_ "0. Environment"
say "uname: $(uname -a | mask)"
say "node:  $(node -v 2>&1)"
say "pnpm:  $(pnpm -v 2>&1)"
say "git:   $(git --version 2>&1)"
HAVE_CLAUDE=0; HAVE_AGY=0
command -v claude >/dev/null 2>&1 && HAVE_CLAUDE=1
command -v agy >/dev/null 2>&1 && HAVE_AGY=1
say "claude on PATH: $HAVE_CLAUDE ($(command -v claude 2>/dev/null | mask))"
say "agy on PATH:    $HAVE_AGY ($(command -v agy 2>/dev/null | mask))"
[ "$HAVE_CLAUDE" = 1 ] && say "claude --version: $(claude --version 2>&1 | head -1)"
[ "$HAVE_AGY" = 1 ] && say "agy --version:    $(agy --version 2>&1 | head -1)"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/sb-recon.XXXXXX")"
finalize() { rm -rf "$WORK"; [ -f "$REPORT" ] && mask <"$REPORT" >"$REPORT.tmp" && mv "$REPORT.tmp" "$REPORT"; }
trap finalize EXIT
trap 'exit 130' INT TERM
mkdir -p "$WORK"

# ---- help output + interesting flags
for AG in claude agy; do
  eval "have=\$HAVE_$(echo "$AG" | tr a-z A-Z)"
  head_ "1. $AG --help (flag hints)"
  if [ "$have" != 1 ]; then say "SKIPPED: $AG not installed"; continue; fi
  run_to 30 "$WORK/$AG.help" "$AG" --help
  say "exit code: $RC"
  say "lines mentioning output/permission/approve/sandbox/model/usage/quota/print/allow/deny:"
  grep -iE 'output|permission|approve|yolo|sandbox|model|usage|quota|print|allow|deny|settings|json|prompt' "$WORK/$AG.help" | head -n 50 | sed 's/^/    /' >>"$REPORT"
done
if [ "$HAVE_AGY" = 1 ]; then
  head_ "1b. agy models / usage subcommands"
  run_to 30 "$WORK/agy.models" agy models
  say "agy models exit code: $RC"
  dump "$WORK/agy.models" 30
  for sub in usage quota; do
    run_to 30 "$WORK/agy.$sub" agy "$sub" --help
    say "agy $sub --help exit code: $RC"
    dump "$WORK/agy.$sub" 8
  done
fi

# ---- claude headless
head_ "2. claude -p headless (temp dir, default permissions)"
if [ "$HAVE_CLAUDE" != 1 ]; then
  say "SKIPPED: claude not installed"
else
  CD="$WORK/claude-run"; mkdir -p "$CD"; cd "$CD" || exit 1
  PROMPT='1) Create a file named hello.txt containing the word hi. 2) Run the shell command: echo SB_SHELL_OK > shell.txt . 3) Reply with the single word done.'
  run_to "$TIMEOUT_SECS" "$WORK/claude.out" claude -p "$PROMPT" --output-format json
  say "exit code: $RC (124 = timeout)"
  say "hello.txt created: $([ -f hello.txt ] && echo yes || echo no)"
  say "shell.txt created (shell allowed without prompt): $([ -f shell.txt ] && echo yes || echo no)"
  say "JSON output shape:"
  json_keys "$WORK/claude.out" | sed 's/^/    /' >>"$REPORT"
  say "raw output (first 15 lines):"
  dump "$WORK/claude.out" 15
  cd "$START_DIR" || exit 1
fi

# ---- agy headless, no TTY and with TTY
head_ "3. agy -p headless (temp dirs, default permissions)"
if [ "$HAVE_AGY" != 1 ]; then
  say "SKIPPED: agy not installed"
else
  AGY_PROMPT='1) Create a file named hello.txt containing the word hi. 2) Run the shell command: echo SB_SHELL_OK > shell.txt . 3) In your final reply include every token of the form SB_xxx_RULE that project rules files tell you to include, or the word NONE.'
  for MODE in notty tty; do
    D="$WORK/agy-$MODE"; mkdir -p "$D"; cd "$D" || exit 1
    # Rules-file probe: which of these files does agy pick up automatically?
    echo 'Project rule: always include the token SB_GEMINI_RULE in your final reply.' >GEMINI.md
    echo 'Project rule: always include the token SB_AGENTS_RULE in your final reply.' >AGENTS.md
    echo 'Project rule: always include the token SB_CLAUDE_RULE in your final reply.' >CLAUDE.md
    OUT="$WORK/agy-$MODE.out"
    if [ "$MODE" = tty ]; then
      if [ -t 3 ]; then
        USE_TTY_STDIN=1
        run_to "$TIMEOUT_SECS" "$OUT" with_pty agy -p "$AGY_PROMPT" --output-format json
        USE_TTY_STDIN=0
      else
        say "[tty] SKIPPED: no terminal on stdin"; cd "$START_DIR" || exit 1; continue
      fi
    else
      run_to "$TIMEOUT_SECS" "$OUT" agy -p "$AGY_PROMPT" --output-format json
    fi
    say "[$MODE] exit code: $RC (124 = timeout/hang)"
    if [ "$RC" -ne 0 ] && grep -qiE 'unknown|unrecognized|invalid.*(flag|option)' "$OUT"; then
      say "[$MODE] --output-format json rejected, retrying with plain -p"
      if [ "$MODE" = tty ]; then USE_TTY_STDIN=1; run_to "$TIMEOUT_SECS" "$OUT" with_pty agy -p "$AGY_PROMPT"; USE_TTY_STDIN=0
      else run_to "$TIMEOUT_SECS" "$OUT" agy -p "$AGY_PROMPT"; fi
      say "[$MODE] retry exit code: $RC"
    fi
    say "[$MODE] stdout/stderr bytes: $(wc -c <"$OUT" | tr -d ' ')"
    say "[$MODE] hello.txt created: $([ -f hello.txt ] && echo yes || echo no)"
    say "[$MODE] shell.txt created (shell allowed without prompt): $([ -f shell.txt ] && echo yes || echo no)"
    for T in GEMINI AGENTS CLAUDE; do
      say "[$MODE] rules marker SB_${T}_RULE seen in reply: $(grep -q "SB_${T}_RULE" "$OUT" && echo yes || echo no)"
    done
    say "[$MODE] raw output (first 20 lines):"
    dump "$OUT" 20
    cd "$START_DIR" || exit 1
  done
fi

# ---- statusLine facts about the real settings (read-only, only statusLine key)
head_ "4. ~/.claude/settings.json statusLine (read-only)"
if [ -f "$HOME/.claude/settings.json" ]; then
  node -e '
    const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    console.log("has statusLine:", "statusLine" in s);
    if (s.statusLine) console.log(JSON.stringify(s.statusLine));
  ' "$HOME/.claude/settings.json" 2>&1 | sed 's/^/    /' >>"$REPORT"
else
  say "    no ~/.claude/settings.json"
fi

# ---- examples of limit messages
# Bounded on purpose: only recent small files, a pattern without a leading
# wildcard (fast on BSD grep), at most 3 hits per file and a hard 60 s timeout.
head_ "5. Limit-message examples found locally (max 8 lines, 160 chars each)"
PAT='(usage limit|limit reached|limit will reset|resets at|rate_limit_error|RESOURCE_EXHAUSTED)'
find_limit_lines() { # find_limit_lines <dir> <name-glob>...
  local dir=$1; shift
  local args=() g
  for g in "$@"; do args+=(-o -name "$g"); done
  find "$dir" -type f -mtime -30 -size -5000k \( -name '__none__' "${args[@]}" \) -print0 2>/dev/null \
    | tr '\0' '\n' | head -n 60 | tr '\n' '\0' \
    | xargs -0 grep -m 3 -hoiE "${PAT}.{0,100}" 2>/dev/null \
    | head -n 8 | cut -c1-160
}
if [ "${SB_RECON_SKIP_LOGS:-0}" = 1 ]; then
  say "SKIPPED (SB_RECON_SKIP_LOGS=1)"
else
  if [ -d "$HOME/.claude/projects" ]; then
    say "claude sessions:"
    run_to 60 "$WORK/limits.claude" find_limit_lines "$HOME/.claude/projects" '*.jsonl'
    say "    (exit code $RC, 124 = timeout)"
    dump "$WORK/limits.claude" 8
  fi
  say "agy/gemini/antigravity config dirs found (names only):"
  for d in "$HOME/.gemini" "$HOME/.antigravity" "$HOME/.antigravity_cli" "$HOME/.config/antigravity" "$HOME/.config/agy" \
           "$HOME/Library/Application Support/Antigravity" "$HOME/Library/Application Support/agy"; do
    [ -d "$d" ] && say "    $(printf '%s' "$d" | mask)"
  done
  for d in "$HOME/.gemini" "$HOME/.antigravity" "$HOME/.config/antigravity"; do
    if [ -d "$d" ]; then
      run_to 60 "$WORK/limits.agy" find_limit_lines "$d" '*.log' '*.jsonl'
      say "    $(basename "$d") logs (exit code $RC):"
      dump "$WORK/limits.agy" 8
    fi
  done
fi

# ---- statusLine probe setup (manual step, project-local settings only)
rm -rf "$PROBE_DIR"; mkdir -p "$PROBE_DIR/.claude"
node -e '
  const p = process.argv[1];
  const cmd = "cat > " + JSON.stringify(p + "/dump.json") + "; echo sb-probe";
  require("fs").writeFileSync(p + "/.claude/settings.local.json",
    JSON.stringify({ statusLine: { type: "command", command: cmd } }, null, 2));
' "$PROBE_DIR"
head_ "6. statusLine probe (MANUAL STEP)"
say "Probe dir prepared: $PROBE_DIR (project-local settings only, ~/.claude untouched)"

# Mask the whole report in place.
mask <"$REPORT" >"$REPORT.tmp" && mv "$REPORT.tmp" "$REPORT"

cat <<EOF

Recon report: $REPORT   (review it before sending)

Manual step for the statusLine probe (needs your real Claude login):
  cd "$PROBE_DIR" && claude
  -> accept the trust prompt, send one short message (e.g. "hi"), wait for the
     answer, then exit with /exit.
  Then run:  scripts/recon.sh collect
  and send the second file (sb-recon-statusline-*.txt) too.
EOF
