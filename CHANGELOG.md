# Changelog

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
