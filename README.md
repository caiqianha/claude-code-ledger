# ccledger

[![npm](https://img.shields.io/npm/v/claude-code-ledger?color=cb3837)](https://www.npmjs.com/package/claude-code-ledger)
[![license](https://img.shields.io/github/license/caiqianha/claude-code-ledger)](./LICENSE)
[![node](https://img.shields.io/node/v/claude-code-ledger)](./package.json)
![deps](https://img.shields.io/badge/dependencies-0-success)

**Local-first cost & tool-call audit for [Claude Code](https://claude.com/claude-code).**

![ccledger demo](https://raw.githubusercontent.com/caiqianha/claude-code-ledger/main/assets/demo.gif)

<sub>[Open the demo HTML report](https://caiqianha.github.io/claude-code-ledger/) · Demo recorded on synthetic data from `scripts/demo-data.mjs`. No real session appears anywhere in this repo.</sub>

Reads the session logs Claude Code already writes to `~/.claude/projects/`, and tells you where the tokens went: per day, per project, per session, per model, per tool, plus the call patterns that burn context for nothing.

## Why

Token dashboards tell you *how much* you spent. `ccledger` also tells you *on what*, at the tool-call level:

- which tool is called most, fails most, and returns the most bytes into your context
- the same file read 8 times in one session
- an identical command re-run right after it failed
- a 60 KB tool output that gets re-sent on every following turn
- long sessions whose cache hit rate collapsed
- **what each tool result actually cost** once it sat in the context window for the rest of the session

Each finding comes with a one-line hint, and `ccledger advise` turns the lot into a paste-ready `CLAUDE.md` block.

## Install

```bash
npm install -g claude-code-ledger   # installs the `ccledger` command
npx claude-code-ledger              # or run it once without installing
```

Node 18+. Zero runtime dependencies. The npm package is `claude-code-ledger`; the CLI is `ccledger`.

## Usage

```
ccledger [command] [options]

Reports
  summary          Totals, per-model split, top tools, top context, top waste (default)
  daily            One row per day (est + apportioned reported cost)
  projects         One row per project
  sessions         Most expensive sessions (with subagent share)
  tools            Calls / errors / latency / output size / context cost per tool
  context          Most expensive tool results by file / command / query
  waste            Wasteful call patterns with hints
  models           Token split per model
  advise           Paste-ready CLAUDE.md block built from the findings
  report           Single-file HTML report (--out report.html)

Live & integration
  watch            Live view of the current session (--session <id-prefix>)
  hook             One-line session summary for a Claude Code Stop hook
  statusline       Status bar line for Claude Code's statusLine setting
  merge <a.json..> Combine several --json exports (e.g. a team) into one report

Pricing
  calibrate        Compare estimates with Claude Code's own cost-state (--write to apply)
  update-pricing   Download the latest pricing table into ~/.config/ccledger/pricing.json

Options
  --since <v>      7d | 24h | today | yesterday | YYYY-MM-DD   (default: all)
  --until <v>      YYYY-MM-DD (inclusive)
  --project <s>    Substring match on project name / path
  --dir <path>     Log directory, repeatable (default: $CCLEDGER_DIR or ~/.claude/projects)
  --top <n>        Rows to show in ranked tables (default: 15)
  --large <chars>  "Large output" threshold in characters (default: 30000)
  --kind <k>       waste only: repeat | retry | large-output | error-prone | cold-cache
  --json           Print the aggregate as JSON
  --no-color       Disable ANSI colors (also honours NO_COLOR)
```

Examples:

```bash
ccledger daily --since 7d
ccledger sessions --project my-app --top 5
ccledger context --since 30d          # which files / commands cost the most to keep in context
ccledger advise --since 14d >> CLAUDE.md
ccledger report --since 30d --out report.html
ccledger watch                        # leave it open in a split pane while you work
```

No logs of your own yet? Try it on synthetic data:

```bash
npm run demo          # generates /tmp/ccledger-demo and prints a summary
```

### Stop hook: a cost line after every session

Add to `~/.claude/settings.json` (or a project's `.claude/settings.json`):

```json
{
  "hooks": {
    "Stop": [{ "hooks": [{ "type": "command", "command": "ccledger hook" }] }]
  }
}
```

Claude Code pipes the session id and transcript path to the hook; `ccledger hook` prints the session's cost, cache hit rate, tool calls and its single worst waste finding.

### Status line: cost and context in the Claude Code status bar

```json
{
  "statusLine": { "type": "command", "command": "ccledger statusline" }
}
```

Claude Code runs the command after every assistant message and pipes it the session JSON. `ccledger statusline` prints one line:

```
Opus · $1.94 · ctx 62.3k 31% · 51 calls · cache 99% · 5.75M tok · ⚠ repeat Glob **/*.test.js ×4
```

Cost and context come from Claude Code itself, tool counts and the top waste flag from the transcript. The transcript is tailed incrementally (byte offset cached under the OS temp dir), so each refresh parses only the new lines. Segments are dropped from the right when the terminal is narrow; `--no-cache` forces a full re-parse.

### Team view

Everyone runs `ccledger --json --since 30d > me.json`; collect the files and run `ccledger merge *.json`. Exports contain no message content, only the aggregates you see in the tables.

## How costs are computed

Two numbers are shown and they are intentionally different:

| column | source | notes |
| --- | --- | --- |
| **reported $** | Claude Code's own `cost-state` records | What Claude Code itself believes the session cost. Whole-session totals, so they ignore `--since`. Treat this as the truth when present. |
| **est $** | `usage` on every API message × [`pricing.json`](./pricing.json) | Works per day / per model / per project. List prices for the first-party API; edit the file if your rates differ. Unknown models show `$…+` and are flagged. |

A third number, **context $**, is attributed to tool results: a result enters the prompt once (cache write) and is re-read on every later API message in the session until the next compaction, so `cost ≈ tokens × (cache_write + cache_read × later_messages)`. It is an estimate, but a consistent one, so files, commands and tools rank fairly against each other.

Streaming splits one API message across several log lines that repeat the same `usage`; `ccledger` de-duplicates by message id, so tokens are counted once. Subagent (sidechain) messages are included in totals and shown separately as `agents $` in `sessions` and `summary`.

## Privacy

`ccledger` never prints or stores message text, thinking, or tool output. It reads:

- token counts and model ids
- tool names, file paths and the first 80 characters of a command or query (for the `detail` column)
- the *size* of tool results, not their content

Everything runs locally. There is no network access of any kind.

## Waste detectors

| kind | fires when | typical fix |
| --- | --- | --- |
| `repeat` | the same read-like call (Read / Grep / Bash / MCP…) appears ≥4× within one compaction window of a session | read a narrower range, keep notes, add a `CLAUDE.md` rule |
| `retry` | an identical call is re-issued right after it failed | change the input before retrying |
| `large-output` | a single tool result ≥ 30 000 chars | pipe through `head` / `grep`, use `limit` |
| `error-prone` | a tool fails ≥25 % of the time in a session (≥5 calls) | permission rule, missing binary, wrong cwd |
| `cold-cache` | ≥500k tokens in a session with cache hit <50 % | avoid long idle gaps, keep the system prompt stable |

Thresholds live in `src/analyze.js`; `--large` overrides the output threshold from the CLI.

## Roadmap

- [x] per-tool / per-file context cost attribution
- [x] `advise`: export findings as a CLAUDE.md block
- [x] `watch` mode, Stop hook and status line
- [x] HTML report, team `merge`
- [x] subagent breakdown, compaction-aware detectors, calibration against cost-state
- [ ] per-turn timeline view
- [ ] loaders for other agent CLIs' logs

## Development

```bash
npm test              # node:test, no extra deps
npm run demo          # synthetic data + summary
npm run demo:gif      # re-render assets/demo.gif (needs vhs)
```

See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a PR.

Contributions welcome. Run `npm test` before opening a PR.
## 中文说明

`ccledger` 是一个本地运行的 Claude Code 账单与工具调用审计工具。它读取 `~/.claude/projects/` 下已有的会话日志，按天、项目、会话、模型、工具统计 token 与花费，并找出浪费上下文的调用模式：同一文件反复读取、失败后原样重试、超大工具输出、缓存命中率崩掉的长会话。

- 不联网，不读取也不输出任何消息正文，只看 token 数、工具名、文件路径和输出大小。
- `reported $` 来自 Claude Code 自己记录的 `cost-state`，是整个会话的真实花费；`est $` 按 `pricing.json` 估算，可以按天 / 按模型拆分，价格表可自行修改。
- 每条浪费项附带一句建议，可直接写进 `CLAUDE.md` 或做成 hook。

```bash
npm i -g claude-code-ledger   # 安装后命令是 ccledger
ccledger                      # 总览
ccledger context              # 哪些文件 / 命令占着上下文最烧钱
ccledger advise >> CLAUDE.md  # 把发现变成规则
ccledger watch                # 开在旁边实时看当前会话
ccledger report               # 单文件 HTML 报告
```


`context $` 是工具结果的上下文成本：一条结果进入上下文后，会话里之后每一次 API 调用都要为它付一次缓存读取，直到压缩为止。`calibrate` 用 Claude Code 自己记录的花费校准估算单价。Stop hook 配置见上文 Stop hook 一节。

## License

MIT
