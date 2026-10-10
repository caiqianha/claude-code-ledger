import { parseArgs } from "node:util";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultDir, listSessionFiles, iterRecords } from "./loader.js";
import { buildModel } from "./parse.js";
import { loadPricing, updatePricing, writeCalibrated, userPricingPath } from "./pricing.js";
import { analyze, totalTokens, cacheHitRate } from "./analyze.js";
import { advise } from "./advise.js";
import { mergeReports } from "./merge.js";
import { renderHtml } from "./report.js";
import { watch } from "./watch.js";
import { table, heading, kv, fmtNum, fmtUsd, fmtPct, fmtDur, fmtMs, fmtDate, short, truncate, setColor, c, sev } from "./render.js";

const { version } = createRequire(import.meta.url)("../package.json");

const HELP = `ccledger ${version} — local-first cost & tool-call audit for Claude Code

Usage: ccledger [command] [options]

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
  hook             One-line session summary for a Claude Code Stop hook (reads hook JSON on stdin)
  merge <a.json..> Combine several --json exports (e.g. a team) into one report

Pricing
  calibrate        Compare estimates with Claude Code's own cost-state (--write to apply)
  update-pricing   Download the latest pricing table into ${userPricingPath()}

Options
  --since <v>      7d | 24h | today | yesterday | YYYY-MM-DD   (default: all)
  --until <v>      YYYY-MM-DD (inclusive)
  --project <s>    Substring match on project name / path
  --dir <path>     Log directory, repeatable (default: $CCLEDGER_DIR or ~/.claude/projects)
  --top <n>        Rows to show in ranked tables (default: 15)
  --large <chars>  "Large output" threshold in characters (default: 30000)
  --kind <k>       waste only: repeat | retry | large-output | error-prone | cold-cache
  --session <s>    watch / hook: session id prefix
  --out <file>     report: output path (default: ccledger-report.html)
  --pricing <f>    Alternate pricing.json
  --json           Print the aggregate as JSON instead of tables
  --no-color       Disable ANSI colors (also honours NO_COLOR)
  -h, --help       Show this help
  -v, --version    Show version

Privacy: only token counts, tool names, file paths / command previews and
output sizes are read. Message text is never loaded into the report.
`;

export async function main(argv, io = { stdout: process.stdout, stderr: process.stderr, stdin: process.stdin }) {
  const { values: o, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      since: { type: "string" },
      until: { type: "string" },
      project: { type: "string" },
      dir: { type: "string", multiple: true },
      top: { type: "string", default: "15" },
      large: { type: "string" },
      kind: { type: "string" },
      session: { type: "string" },
      out: { type: "string" },
      pricing: { type: "string" },
      json: { type: "boolean", default: false },
      write: { type: "boolean", default: false },
      once: { type: "boolean", default: false },
      "no-color": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
    },
  });
  const print = (s) => io.stdout.write(s + "\n");
  if (o.help) return io.stdout.write(HELP);
  if (o.version) return print(version);
  setColor(!o["no-color"] && !process.env.NO_COLOR && io.stdout.isTTY && !o.json);

  const cmd = positionals[0] || "summary";
  const dirs = o.dir?.length ? o.dir : [process.env.CCLEDGER_DIR || defaultDir()];
  const pricing = loadPricing(o.pricing);
  const top = Number(o.top) || 15;

  // ---- commands that do not need the full log scan ----
  if (cmd === "update-pricing") {
    const dest = await updatePricing();
    return print(`Pricing written to ${dest}`);
  }
  if (cmd === "merge") {
    const files = positionals.slice(1);
    if (!files.length) throw new Error("merge needs at least one --json export file");
    const reports = files.map((f) => JSON.parse(fs.readFileSync(f, "utf8")));
    const merged = mergeReports(reports);
    return emit(merged, "summary", { o, top, print });
  }
  if (cmd === "watch") {
    return watch({ dir: dirs[0], session: o.session, pricing, out: io.stdout, once: o.once });
  }
  if (cmd === "hook") {
    return hook({ dirs, pricing, session: o.session, io, print });
  }

  // ---- full scan ----
  const files = dirs.flatMap((d) => listSessionFiles(d));
  if (!files.length) {
    io.stderr.write(`No session logs found under ${dirs.join(", ")}\n`);
    process.exitCode = 1;
    return;
  }
  const t0 = Date.now();
  const model = await buildModel(iterRecords(files));
  const report = analyze(model, {
    pricing,
    since: parseSince(o.since),
    until: parseUntil(o.until),
    project: o.project,
    largeOutput: o.large ? Number(o.large) : undefined,
  });
  report.meta = { dir: dirs.join(", "), files: files.length, lines: model.stats.lines, parseMs: Date.now() - t0, pricing: pricing._source };

  if (cmd === "calibrate") return calibrateCmd(report, pricing, { o, print });
  if (cmd === "report") {
    const outFile = o.out || "ccledger-report.html";
    fs.writeFileSync(outFile, renderHtml(report, { title: `ccledger · ${report.range.project || "all projects"}` }));
    return print(`Report written to ${path.resolve(outFile)}`);
  }
  if (cmd === "advise") return print(advise(report, { max: top, days: daysOf(o.since) }));
  return emit(report, cmd, { o, top, print });
}

function emit(report, cmd, { o, top, print }) {
  if (o.json) {
    const plain = JSON.parse(JSON.stringify(report, (k, v) => (k === "session" ? sessionBrief(v) : v)));
    return print(JSON.stringify(plain, null, 2));
  }
  const out = [];
  switch (cmd) {
    case "summary":
      out.push(renderSummary(report, top));
      break;
    case "daily":
      out.push(renderDaily(report));
      break;
    case "projects":
      out.push(renderProjects(report, top));
      break;
    case "sessions":
      out.push(renderSessions(report, top));
      break;
    case "tools":
      out.push(renderTools(report, top));
      break;
    case "context":
      out.push(renderContext(report, top));
      break;
    case "waste":
      if (o.kind) report.waste = report.waste.filter((f) => f.kind === o.kind);
      else report.waste = interleaveByKind(report.waste, report.waste.length);
      out.push(renderWaste(report, top));
      break;
    case "models":
      out.push(renderModels(report));
      break;
    default:
      process.stderr.write(`Unknown command: ${cmd}\n\n`);
      process.stdout.write(HELP);
      process.exitCode = 1;
      return;
  }
  out.push(footer(report));
  print(out.join("\n"));
}

/* ------------------------------------------------------------------ */

function sessionBrief(s) {
  return s && { id: s.id, project: s.project, firstTs: s.firstTs, lastTs: s.lastTs, humanTurns: s.humanTurns, compactions: s.compactions?.length ?? 0 };
}

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x.getTime();
}

export function parseSince(v, now = Date.now()) {
  if (!v) return undefined;
  if (v === "today") return startOfDay(now);
  if (v === "yesterday") return startOfDay(now) - 86_400_000;
  const m = /^(\d+)([dhw])$/.exec(v);
  if (m) {
    const n = Number(m[1]);
    const unit = { h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 }[m[2]];
    return now - n * unit;
  }
  const t = Date.parse(v);
  if (Number.isNaN(t)) throw new Error(`Bad --since value: ${v}`);
  return startOfDay(t);
}

export function parseUntil(v) {
  if (!v) return undefined;
  const t = Date.parse(v);
  if (Number.isNaN(t)) throw new Error(`Bad --until value: ${v}`);
  return startOfDay(t) + 86_400_000 - 1;
}

function daysOf(since) {
  const m = /^(\d+)([dw])$/.exec(since || "");
  return m ? Number(m[1]) * (m[2] === "w" ? 7 : 1) : undefined;
}

/* ------------------------------------------------------------------ */

const tokenCols = [
  { key: "input", label: "input", align: "r", fmt: fmtNum },
  { key: "output", label: "output", align: "r", fmt: fmtNum },
  { key: "cacheRead", label: "cache rd", align: "r", fmt: fmtNum },
  { key: "cacheWrite", label: "cache wr", align: "r", fmt: fmtNum },
  { key: "_hit", label: "hit", align: "r", fmt: (_, r) => fmtPct(cacheHitRate(r)) },
  { key: "est", label: "est $", align: "r", fmt: (v, r) => fmtUsd(v, r.unknownModel) },
];

function renderSummary(r, top) {
  const t = r.totals;
  const parts = [];
  parts.push(heading("Totals"));
  parts.push(
    kv([
      ["sessions", `${r.sessionsIncluded}`],
      ["API messages", fmtNum(t.messages)],
      ["tokens", `${fmtNum(totalTokens(t))}  (in ${fmtNum(t.input)} · out ${fmtNum(t.output)} · cache rd ${fmtNum(t.cacheRead)} · cache wr ${fmtNum(t.cacheWrite)})`],
      ["cache hit", fmtPct(cacheHitRate(t))],
      ["thinking tokens", fmtNum(t.thinking)],
      ["tool calls", `${fmtNum(t.toolCalls)}  (${t.toolErrors} errors, ${fmtNum(t.resultChars)} chars returned, ~${fmtUsd(t.ctxCost)} context cost)`],
      ["estimated cost", fmtUsd(t.est, t.unknownModel) + (t.sub ? `   (${fmtUsd(t.sub)} by subagents, ${fmtPct(t.est ? t.sub / t.est : 0)})` : "") + (t.unknownModel ? c.yellow("   some models missing from pricing.json") : "")],
      ["reported cost", r.reported.sessions ? `${fmtUsd(r.reported.usd)}   (Claude Code cost-state, ${r.reported.sessions}/${r.reported.of} sessions, whole-session totals)` : "n/a"],
    ]),
  );
  parts.push(heading("By model"));
  parts.push(table(r.byModel, [{ key: "key", label: "model", max: 28 }, { key: "messages", label: "msgs", align: "r", fmt: fmtNum }, ...tokenCols]));
  parts.push(heading("Top tools"));
  parts.push(toolTable(r.byTool.slice(0, Math.min(top, 8))));
  parts.push(heading("Most expensive context"));
  parts.push(contextTable(r.byContext.slice(0, Math.min(top, 5))));
  parts.push(heading("Top waste"));
  parts.push(r.waste.length ? wasteTable(interleaveByKind(r.waste, Math.min(top, 8))) : "nothing flagged");
  parts.push(c.dim("\nMore: ccledger waste · sessions · tools · context · advise · report · watch"));
  return parts.join("\n");
}

function renderDaily(r) {
  return heading("Daily") + "\n" + table(r.byDay, [
    { key: "key", label: "day" },
    { key: "messages", label: "msgs", align: "r", fmt: fmtNum },
    ...tokenCols,
    { key: "reported", label: "reported $", align: "r", fmt: (v) => (v == null ? "-" : fmtUsd(v)) },
    { key: "toolCalls", label: "tools", align: "r", fmt: fmtNum },
    { key: "toolErrors", label: "errs", align: "r" },
  ]) + c.dim("\nreported $ is Claude Code's session total, apportioned to days by each day's share of the estimate.");
}

function renderProjects(r, top) {
  return heading("Projects") + "\n" + table(r.byProject.slice(0, top), [
    { key: "key", label: "project", max: 32 },
    { key: "messages", label: "msgs", align: "r", fmt: fmtNum },
    ...tokenCols,
    { key: "sub", label: "agents $", align: "r", fmt: (v) => (v ? fmtUsd(v) : "-") },
    { key: "toolCalls", label: "tools", align: "r", fmt: fmtNum },
    { key: "toolErrors", label: "errs", align: "r" },
  ]);
}

function renderSessions(r, top) {
  return heading("Sessions (most expensive first)") + "\n" + table(r.bySession.slice(0, top), [
    { key: "key", label: "session", fmt: (v) => short(v) },
    { key: "session", label: "started", fmt: (s) => fmtDate(s.firstTs) },
    { key: "session", label: "project", fmt: (s) => s.project, max: 24 },
    { key: "session", label: "wall", align: "r", fmt: (s) => fmtDur(s.lastTs - s.firstTs) },
    { key: "session", label: "turns", align: "r", fmt: (s) => s.humanTurns },
    { key: "session", label: "cmp", align: "r", fmt: (s) => s.compactions?.length ?? s.compactions ?? 0 },
    { key: "messages", label: "msgs", align: "r", fmt: fmtNum },
    { key: "_tok", label: "tokens", align: "r", fmt: (_, row) => fmtNum(totalTokens(row)) },
    { key: "_hit", label: "hit", align: "r", fmt: (_, row) => fmtPct(cacheHitRate(row)) },
    { key: "toolCalls", label: "tools", align: "r", fmt: fmtNum },
    { key: "toolErrors", label: "errs", align: "r" },
    { key: "est", label: "est $", align: "r", fmt: (v, row) => fmtUsd(v, row.unknownModel) },
    { key: "sub", label: "agents $", align: "r", fmt: (v) => (v ? fmtUsd(v) : "-") },
    { key: "reported", label: "reported $", align: "r", fmt: (v) => (v == null ? "-" : fmtUsd(v)) },
    { key: "linesAdded", label: "+/-", align: "r", fmt: (v, row) => (v == null ? "-" : `+${v}/-${row.linesRemoved}`) },
  ]) + c.dim("\ncmp = compactions · agents $ = spent by subagents inside the session");
}

function toolTable(rows) {
  return table(rows, [
    { key: "key", label: "tool", max: 40 },
    { key: "calls", label: "calls", align: "r", fmt: fmtNum },
    { key: "errors", label: "errs", align: "r" },
    { key: "_rate", label: "err%", align: "r", fmt: (_, r) => fmtPct(r.calls ? r.errors / r.calls : 0) },
    { key: "_ms", label: "avg took", align: "r", fmt: (_, r) => (r.msCount ? fmtMs(r.msTotal / r.msCount) : "-") },
    { key: "resultChars", label: "out chars", align: "r", fmt: fmtNum },
    { key: "_avg", label: "avg", align: "r", fmt: (_, r) => fmtNum(r.calls ? r.resultChars / r.calls : 0) },
    { key: "maxResultChars", label: "max", align: "r", fmt: fmtNum },
    { key: "ctxCost", label: "context $", align: "r", fmt: (v) => fmtUsd(v) },
  ]);
}

function renderTools(r, top) {
  return heading("Tools") + "\n" + toolTable(r.byTool.slice(0, top)) + c.dim("\ncontext $ ≈ tokens of each result × (one cache write + a cache read on every later message until compaction)");
}

function contextTable(rows) {
  return table(rows, [
    { key: "tool", label: "tool", max: 28 },
    { key: "preview", label: "input", max: 60 },
    { key: "calls", label: "calls", align: "r" },
    { key: "sessions", label: "sess", align: "r" },
    { key: "chars", label: "chars", align: "r", fmt: fmtNum },
    { key: "ctxCost", label: "context $", align: "r", fmt: (v) => fmtUsd(v) },
  ]);
}

function renderContext(r, top) {
  return heading("Most expensive context (by file / command / query)") + "\n" + contextTable(r.byContext.slice(0, top));
}

/** Round-robin across finding kinds so a list shows variety, not eight of the same. */
function interleaveByKind(findings, n) {
  const buckets = new Map();
  for (const f of findings) (buckets.get(f.kind) || buckets.set(f.kind, []).get(f.kind)).push(f);
  const out = [];
  while (out.length < n) {
    let took = false;
    for (const b of buckets.values()) {
      if (b.length && out.length < n) {
        out.push(b.shift());
        took = true;
      }
    }
    if (!took) break;
  }
  return out;
}

function wasteTable(rows) {
  return table(rows, [
    { key: "severity", label: "sev", fmt: sev },
    { key: "kind", label: "kind" },
    { key: "tool", label: "tool", max: 28 },
    { key: "count", label: "n", align: "r" },
    { key: "chars", label: "chars", align: "r", fmt: fmtNum },
    { key: "usd", label: "~$", align: "r", fmt: (v) => (v ? fmtUsd(v) : "-") },
    { key: "project", label: "project", max: 18 },
    { key: "sessionId", label: "session", fmt: (v) => short(v) },
    { key: "detail", label: "detail", max: 56 },
  ]);
}

function renderWaste(r, top) {
  if (!r.waste.length) return heading("Waste") + "\nnothing flagged";
  const parts = [heading(`Waste (${r.waste.length} findings)`), wasteTable(r.waste.slice(0, top))];
  const hints = new Map();
  for (const f of r.waste) hints.set(f.kind, f.hint);
  parts.push(c.bold("\nHints"));
  for (const [k, h] of hints) parts.push(`  ${k.padEnd(13)} ${truncate(h, 110)}`);
  parts.push(c.dim("\nTurn these into rules: ccledger advise"));
  return parts.join("\n");
}

function renderModels(r) {
  return heading("Models") + "\n" + table(r.byModel, [
    { key: "key", label: "model", max: 36 },
    { key: "messages", label: "msgs", align: "r", fmt: fmtNum },
    { key: "thinking", label: "thinking", align: "r", fmt: fmtNum },
    ...tokenCols,
  ]);
}

function calibrateCmd(report, pricing, { o, print }) {
  const cal = report.calibration;
  const parts = [heading("Calibration: Claude Code reported ÷ ccledger estimate")];
  if (!cal.sessions.length) {
    parts.push("No sessions with both a cost-state record and a known-model estimate.");
    return print(parts.join("\n"));
  }
  parts.push(
    table(cal.sessions.sort((a, b) => Math.abs(1 - b.ratio) - Math.abs(1 - a.ratio)).slice(0, 15), [
      { key: "sessionId", label: "session", fmt: (v) => short(v) },
      { key: "model", label: "primary model", fmt: (v) => v || c.dim("mixed"), max: 28 },
      { key: "est", label: "est $", align: "r", fmt: (v) => fmtUsd(v) },
      { key: "reported", label: "reported $", align: "r", fmt: (v) => fmtUsd(v) },
      { key: "ratio", label: "ratio", align: "r", fmt: (v) => v.toFixed(3) },
    ]),
  );
  parts.push(heading("Per model (sessions where ≥90% of the estimate is one model)"));
  parts.push(
    cal.models.length
      ? table(cal.models, [
          { key: "model", label: "model", max: 28 },
          { key: "sessions", label: "sessions", align: "r" },
          { key: "median", label: "median ratio", align: "r", fmt: (v) => v.toFixed(3) },
          { key: "min", label: "min", align: "r", fmt: (v) => v.toFixed(3) },
          { key: "max", label: "max", align: "r", fmt: (v) => v.toFixed(3) },
          { key: "_act", label: "action", fmt: (_, r) => (r.sessions < 3 ? c.dim("need ≥3 sessions") : Math.abs(1 - r.median) < 0.03 ? c.green("within 3%, keep") : `scale prices ×${r.median.toFixed(3)}`) },
        ])
      : "none",
  );
  const mult = Object.fromEntries(cal.models.filter((m) => m.sessions >= 3 && Math.abs(1 - m.median) >= 0.03).map((m) => [m.model, m.median]));
  if (o.write) {
    if (!Object.keys(mult).length) parts.push("\nNothing to write: every model is within 3% or has too few sessions.");
    else parts.push(`\nWrote calibrated prices for ${Object.keys(mult).join(", ")} to ${writeCalibrated(pricing, mult)}`);
  } else if (Object.keys(mult).length) parts.push(c.dim(`\nRun with --write to save these multipliers to ${userPricingPath()} (delete the file to undo).`));
  parts.push(c.dim(`\npricing in use: ${pricing._source}`));
  print(parts.join("\n"));
}

async function hook({ dirs, pricing, session, io, print }) {
  let transcript = null;
  let sid = session || null;
  if (!io.stdin.isTTY) {
    let raw = "";
    for await (const chunk of io.stdin) raw += chunk;
    try {
      const j = JSON.parse(raw);
      transcript = j.transcript_path || null;
      sid = sid || j.session_id || null;
    } catch {
      /* no JSON on stdin */
    }
  }
  let files = [];
  if (transcript && fs.existsSync(transcript)) files = [{ file: transcript, projectDir: path.basename(path.dirname(transcript)) }];
  else {
    const all = dirs.flatMap((d) => listSessionFiles(d));
    files = sid ? all.filter((f) => path.basename(f.file).startsWith(sid)) : [];
    if (!files.length) files = all.sort((a, b) => fs.statSync(b.file).mtimeMs - fs.statSync(a.file).mtimeMs).slice(0, 1);
  }
  if (!files.length) return;
  const model = await buildModel(iterRecords(files));
  const r = analyze(model, { pricing });
  const ss = r.bySession[0];
  if (!ss) return;
  const line1 = `ccledger: ${fmtUsd(ss.est, ss.unknownModel)} est${ss.reported != null ? ` (${fmtUsd(ss.reported)} reported)` : ""} · ${fmtNum(totalTokens(ss))} tokens · cache hit ${fmtPct(cacheHitRate(ss))} · ${ss.toolCalls} tool calls, ${ss.toolErrors} errors`;
  const w = r.waste[0];
  const line2 = w ? `  top waste: ${w.kind} ${w.tool} ${w.detail}${w.count > 1 ? ` ×${w.count}` : ""}${w.usd ? ` (~${fmtUsd(w.usd)})` : ""}` : "";
  print(line2 ? line1 + "\n" + line2 : line1);
}

function footer(r) {
  const m = r.meta || {};
  const range = [r.range.since ? `since ${new Date(r.range.since).toLocaleDateString("sv-SE")}` : "all time", r.range.project ? `project~"${r.range.project}"` : null].filter(Boolean).join(", ");
  const dir = String(m.dir || "").replace(os.homedir(), "~");
  return c.dim(`\n${m.files ?? "?"} files · ${fmtNum(m.lines || 0)} lines · ${range} · parsed in ${m.parseMs ?? 0}ms · ${dir}`);
}
