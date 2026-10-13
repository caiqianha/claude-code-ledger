# Changelog

## 0.4.0 - 2026-10-13

- **Other agents' logs**: `--agent claude|codex|gemini|cursor|all`. Readers for Codex CLI rollouts (`~/.codex/sessions`, token_count deltas, function_call/local_shell_call/custom_tool_call joined by call_id, compactions), Gemini CLI chat recordings (`~/.gemini/tmp/<hash>/chats/session-*.jsonl`, `$patch`/`$set` wrappers, legacy `.json`, subagents) and Cursor's `state.vscdb` (best effort, via the `sqlite3` CLI with projected `json_extract` columns; skipped with a message when `sqlite3` is missing). All readers produce one normalized turn model (`ingestTurn` in `src/parse.js`); the Claude parser now goes through it too and its output is byte-for-byte unchanged. Multi-agent runs add an `agent` column, a "By agent" table (CLI and HTML report) and `meta.agents`; single-agent Claude JSON exports keep their previous shape.
- Token counts estimated from text length (Gemini messages without `tokens`, most Cursor bubbles) are flagged with `~`; Cursor sessions are never priced and show `n/a` instead of an unknown-model warning.
- `pricing.json`: OpenAI gpt-5 family (5 / 5.1 / 5.2 / 5.3-codex / 5.4 / 5.5, mini / nano / pro, codex-mini), o-series (o1, o3, o3-mini, o3-pro, o4-mini), gpt-4.1 / 4o, and Gemini 2.5 / 3.x tables as list prices as of 2026-10. Same user override file applies.
- `advise --claude-md [--out FILE]`: suggested CLAUDE.md rules, each only when its pattern crossed a threshold (`CLAUDE_MD_THRESHOLDS`) and each followed by the evidence that triggered it (re-read rate, repeated searches / commands, identical retries, large outputs, error-prone tools, cold-cache sessions), with a "how to apply" header.
- `--budget <usd>` (also `budget` in `~/.config/ccledger/config.json` or `$CCLEDGER_BUDGET`): the statusline shows today's estimated spend vs budget, yellow `⚠` from 80%, red `⚠ over` from 100% (markers survive `NO_COLOR` / non-TTY). New `ccledger today` prints the same with today's sessions and top waste finding.
- `ccledger compare [--since] [--until] [--baseline <30d|20 sessions>]`: before/after table of waste rate, avg tokens per session, cache hit rate, cost per session (est and reported), tool calls and error rate, with deltas and a one-line verdict. `--mark "<label>"` stores a timestamp marker in `~/.config/ccledger/state.json`; `compare --mark` compares before vs after the last marker.
- New config module (`src/config.js`): `~/.config/ccledger/config.json` keys `budget`, `agent`, `large`.
- `watch`: session file name is derived with `path.basename`, so Windows paths no longer show the full path.
- CONTRIBUTING guide and issue templates.
- Codex sessions recorded without `token_count` events are kept, with usage estimated from message length and flagged `~`.

## 0.3.0 - 2026-10-12

- `statusline`: one-line status for Claude Code's `statusLine` setting (cost and context from Claude Code, tool calls, cache hit and top waste flag from the transcript), with an incremental byte-offset cache so each refresh only parses new lines.
- Live demo HTML report published at https://caiqianha.github.io/claude-code-ledger/ (synthetic data).
- GitHub Actions CI on Node 18 / 20 / 22.
- README: fixed a broken build that had duplicated the file four times.

## 0.2.0 — 2026-10-10

- **context cost attribution**: every tool result is priced by how long it stayed in context; new `context` command, `context $` column in `tools`, `~$` on waste findings
- **advise**: paste-ready CLAUDE.md block generated from the findings
- **watch**: live view of the current session; **hook**: one-line summary for a Stop hook
- **report**: single-file HTML report with a daily cost chart; **merge**: combine `--json` exports
- **calibrate** / **update-pricing**: compare with Claude Code's cost-state and adjust prices per model; user override at `~/.config/ccledger/pricing.json`
- subagent (sidechain) spend tracked separately (`agents $`)
- repeat detection is compaction-aware; reported cost is apportioned across days
- `tools` shows average latency; MCP inputs are shown as `key=value` instead of raw JSON
- ANSI colors (`--no-color`, `NO_COLOR`), repeatable `--dir`

## 0.1.0 — 2026-10-10

- first release: summary / daily / projects / sessions / tools / waste / models, synthetic demo data, zero dependencies
