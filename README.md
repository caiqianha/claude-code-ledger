# ccledger

[![npm](https://img.shields.io/npm/v/ccledger?color=cb3837)](https://www.npmjs.com/package/ccledger)
[![license](https://img.shields.io/github/license/caiqianha/claude-code-ledger)](./LICENSE)
[![node](https://img.shields.io/node/v/ccledger)](./package.json)
![deps](https://img.shields.io/badge/dependencies-0-success)

**Local-first cost & tool-call audit for [Claude Code](https://claude.com/claude-code).**

![ccledger demo](https://raw.githubusercontent.com/caiqianha/claude-code-ledger/main/assets/demo.gif)

<sub>Demo recorded on synthetic data from `scripts/demo-data.mjs`. No real session appears anywhere in this repo.</sub>

Reads the session logs Claude Code already writes to `~/.claude/projects/`, and tells you where the tokens went: per day, per project, per session, per model, per tool, plus the call patterns that burn context for nothing.

## Why

Token dashboards tell you *how much* you spent. `ccledger` also tells you *on what*, at the tool-call level:

- which tool is called most, fails most, and returns the most bytes into your context
- the same file read 8 times in one session
- an identical command re-run right after it failed
- a 60 KB tool output that gets re-sent on every following turn
- long sessions whose cache hit rate collapsed

Each finding comes with a one-line hint you can turn into a `CLAUDE.md` rule or a hook.

## Install

```bash
npm install -g ccledger      # or: npx ccledger
```

Node 18+. Zero runtime dependencies.

## Usage

```
ccledger [command] [options]

Commands
  summary     Totals, per-model split, top tools and top waste (default)
  daily       One row per day
  projects    One row per project
  sessions    Most expensive sessions
  tools       Calls / errors / output size per tool
  waste       Wasteful call patterns with hints
  models      Token split per model

Options
  --since <v>      7d | 24h | today | yesterday | YYYY-MM-DD   (default: all)
  --until <v>      YYYY-MM-DD (inclusive)
  --project <s>    Substring match on project name / path
  --dir <path>     Log directory (default: $CCLEDGER_DIR or ~/.claude/projects)
  --top <n>        Rows to show in ranked tables (default: 15)
  --large <chars>  "Large output" threshold in characters (default: 30000)
  --kind <k>       waste only: repeat | retry | large-output | error-prone | cold-cache
  --pricing <f>    Alternate pricing.json
  --json           Print the aggregate as JSON
```

Examples:

```bash
ccledger daily --since 7d
ccledger sessions --project my-app --top 5
ccledger waste --since today
ccledger waste --kind large-output
ccledger --json --since 30d > usage.json
```

No logs of your own yet? Try it on synthetic data:

```bash
npm run demo          # generates /tmp/ccledger-demo and prints a summary
```

## How costs are computed

Two numbers are shown and they are intentionally different:

| column | source | notes |
| --- | --- | --- |
| **reported $** | Claude Code's own `cost-state` records | What Claude Code itself believes the session cost. Whole-session totals, so they ignore `--since`. Treat this as the truth when present. |
| **est $** | `usage` on every API message × [`pricing.json`](./pricing.json) | Works per day / per model / per project. List prices for the first-party API; edit the file if your rates differ. Unknown models show `$…+` and are flagged. |

Streaming splits one API message across several log lines that repeat the same `usage`; `ccledger` de-duplicates by message id, so tokens are counted once.

## Privacy

`ccledger` never prints or stores message text, thinking, or tool output. It reads:

- token counts and model ids
- tool names, file paths and the first 80 characters of a command or query (for the `detail` column)
- the *size* of tool results, not their content

Everything runs locally. There is no network access of any kind.

## Waste detectors

| kind | fires when | typical fix |
| --- | --- | --- |
| `repeat` | the same read-like call (Read / Grep / Bash / MCP…) appears ≥4× in one session | read a narrower range, keep notes, add a `CLAUDE.md` rule |
| `retry` | an identical call is re-issued right after it failed | change the input before retrying |
| `large-output` | a single tool result ≥ 30 000 chars | pipe through `head` / `grep`, use `limit` |
| `error-prone` | a tool fails ≥25 % of the time in a session (≥5 calls) | permission rule, missing binary, wrong cwd |
| `cold-cache` | ≥500k tokens in a session with cache hit <50 % | avoid long idle gaps, keep the system prompt stable |

Thresholds live in `src/analyze.js`; `--large` overrides the output threshold from the CLI.

## Roadmap

- [ ] `watch` mode: live view of the current session
- [ ] per-tool cost attribution (tokens a tool result occupied × turns it stayed in context)
- [ ] export hints as a ready-to-paste `CLAUDE.md` block
- [ ] subagent / Task breakdown
- [ ] HTML report

## Development

```bash
npm test              # node:test, no extra deps
npm run demo          # synthetic data + summary
npm run demo:gif      # re-render assets/demo.gif (needs vhs)
```

Contributions welcome. Run `npm test` before opening a PR.

## 中文说明

`ccledger` 是一个本地运行的 Claude Code 账单与工具调用审计工具。它读取 `~/.claude/projects/` 下已有的会话日志，按天、项目、会话、模型、工具统计 token 与花费，并找出浪费上下文的调用模式：同一文件反复读取、失败后原样重试、超大工具输出、缓存命中率崩掉的长会话。

- 不联网，不读取也不输出任何消息正文，只看 token 数、工具名、文件路径和输出大小。
- `reported $` 来自 Claude Code 自己记录的 `cost-state`，是整个会话的真实花费；`est $` 按 `pricing.json` 估算，可以按天 / 按模型拆分，价格表可自行修改。
- 每条浪费项附带一句建议，可直接写进 `CLAUDE.md` 或做成 hook。

```bash
npx ccledger                 # 总览
npx ccledger daily --since 7d
npx ccledger waste
```

## License

MIT
