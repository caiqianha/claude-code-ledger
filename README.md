# ccledger

**Local-first cost & tool-call audit for [Claude Code](https://claude.com/claude-code).**

Reads the session logs Claude Code already writes to `~/.claude/projects/`, and tells you where the tokens went: per day, per project, per session, per model, per tool, plus the call patterns that burn context for nothing.

```
$ ccledger --since 30d

Totals
══════
sessions         41
API messages     3.4k
tokens           612.80M  (in 38.1k · out 2.91M · cache rd 591.20M · cache wr 18.55M)
cache hit        97%
tool calls       3.2k  (124 errors, 7.91M chars returned)
estimated cost   $186
reported cost    $174   (Claude Code cost-state, 38/41 sessions)

Top tools
═════════
tool                               calls  errs  err%  out chars   avg    max
─────────────────────────────────  ─────  ────  ────  ─────────  ────  ─────
Bash                                1.6k    61    4%      4.12M  2.6k  58.3k
Read                                 412     5    1%      2.37M  5.8k  61.0k
Edit                                 298     2    1%      54.9k   184    402
Grep                                 203     0    0%      611.3k  3.0k  31.7k
mcp__playwright__browser_snapshot    142     9    6%      522.6k  3.7k   9.8k

Top waste
═════════
sev   kind          tool                               n  chars  project     session   detail
────  ────────────  ─────────────────────────────────  ─  ─────  ──────────  ────────  ─────────────────────────────
high  repeat        Read                               9  52.2k  web-app     7f3a91c2  src/store/modules/order.js
high  large-output  Bash                               1  58.3k  api-server  b02e55d8  npm test 2>&1
high  repeat        mcp__playwright__browser_snapshot  7  25.9k  web-app     7f3a91c2  {"filename":"page.png"}
high  error-prone   Bash                               6      0  api-server  1c9d47aa  6/11 calls failed
med   retry         Bash                               2      0  web-app     e4a8b310  docker compose up -d
```

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
  --dir <path>     Log directory (default: ~/.claude/projects)
  --top <n>        Rows to show in ranked tables (default: 15)
  --large <chars>  "Large output" threshold in characters (default: 30000)
  --pricing <f>    Alternate pricing.json
  --json           Print the aggregate as JSON
```

Examples:

```bash
ccledger daily --since 7d
ccledger sessions --project my-app --top 5
ccledger waste --since today
ccledger --json --since 30d > usage.json
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
| `repeat` | the same read-like call (Read / Grep / Bash / MCP…) appears ≥3× in one session | read a narrower range, keep notes, add a `CLAUDE.md` rule |
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
