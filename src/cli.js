import { parseArgs } from "node:util";
import os from "node:os";
import { createRequire } from "node:module";
import { defaultDir, listSessionFiles, iterRecords } from "./loader.js";
import { buildModel } from "./parse.js";
import { loadPricing } from "./pricing.js";
import { analyze, totalTokens, cacheHitRate } from "./analyze.js";
import { table, heading, kv, fmtNum, fmtUsd, fmtPct, fmtDur, fmtDate, short, truncate } from "./render.js";

const { version } = createRequire(import.meta.url)("../package.json");

const HELP = `ccledger ${version} — local-first cost & tool-call audit for Claude Code

Usage: ccledger [command] [options]

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
                   (without --kind, findings are interleaved across kinds)
  --pricing <f>    Alternate pricing.json
  --json           Print the aggregate as JSON instead of tables
  -h, --help       Show this help
  -v, --version    Show version

Privacy: only token counts, tool names, file paths / command previews and
output sizes are read. Message text is never loaded into the report.
`;

export async function main(argv) {
  const { values: o, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      since: { type: "string" },
      until: { type: "string" },
      project: { type: "string" },
      dir: { type: "string" },
      top: { type: "string", default: "15" },
      large: { type: "string" },
      kind: { type: "string" },
      pricing: { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
    },
  });
  if (o.help) return process.stdout.write(HELP);
  if (o.version) return console.log(version);

  const cmd = positionals[0] || "summary";
  const dir = o.dir || process.env.CCLEDGER_DIR || defaultDir();
  const files = listSessionFiles(dir);
  if (!files.length) {
    console.error(`No session logs found under ${dir}`);
    process.exitCode = 1;
    return;
  }

  const t0 = Date.now();
  const model = await buildModel(iterRecords(files));
  const report = analyze(model, {
    pricing: loadPricing(o.pricing),
    since: parseSince(o.since),
    until: parseUntil(o.until),
    project: o.project,
    largeOutput: o.large ? Number(o.large) : undefined,
  });
  report.meta = { dir, files: files.length, lines: model.stats.lines, parseMs: Date.now() - t0 };

  if (o.json) {
    const plain = JSON.parse(JSON.stringify(report, (k, v) => (k === "session" ? sessionBrief(v) : v)));
    return console.log(JSON.stringify(plain, null, 2));
  }

  const top = Number(o.top) || 15;
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
    case "waste":
      if (o.kind) report.waste = report.waste.filter((f) => f.kind === o.kind);
      else report.waste = interleaveByKind(report.waste, report.waste.length);
      out.push(renderWaste(report, top));
      break;
    case "models":
      out.push(renderModels(report));
      break;
    default:
      console.error(`Unknown command: ${cmd}\n`);
      process.stdout.write(HELP);
      process.exitCode = 1;
      return;
  }
  out.push(footer(report));
  console.log(out.join("\n"));
}

/* ------------------------------------------------------------------ */

function sessionBrief(s) {
  return s && { id: s.id, project: s.project, firstTs: s.firstTs, lastTs: s.lastTs, humanTurns: s.humanTurns };
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
      ["tool calls", `${fmtNum(t.toolCalls)}  (${t.toolErrors} errors, ${fmtNum(t.resultChars)} chars returned)`],
      ["estimated cost", fmtUsd(t.est, t.unknownModel) + (t.unknownModel ? "   (some models missing from pricing.json)" : "")],
      ["reported cost", r.reported.sessions ? `${fmtUsd(r.reported.usd)}   (Claude Code cost-state, ${r.reported.sessions}/${r.reported.of} sessions, whole-session totals)` : "n/a"],
    ]),
  );
  parts.push(heading("By model"));
  parts.push(table(r.byModel, [{ key: "key", label: "model", max: 28 }, { key: "messages", label: "msgs", align: "r", fmt: fmtNum }, ...tokenCols]));
  parts.push(heading("Top tools"));
  parts.push(toolTable(r.byTool.slice(0, Math.min(top, 8))));
  parts.push(heading("Top waste"));
  parts.push(r.waste.length ? wasteTable(interleaveByKind(r.waste, Math.min(top, 8))) : "nothing flagged");
  parts.push("\nRun `ccledger waste`, `ccledger sessions` or `ccledger tools` for the full lists.");
  return parts.join("\n");
}

function renderDaily(r) {
  return heading("Daily") + "\n" + table(r.byDay, [
    { key: "key", label: "day" },
    { key: "messages", label: "msgs", align: "r", fmt: fmtNum },
    ...tokenCols,
    { key: "toolCalls", label: "tools", align: "r", fmt: fmtNum },
    { key: "toolErrors", label: "errs", align: "r" },
  ]);
}

function renderProjects(r, top) {
  return heading("Projects") + "\n" + table(r.byProject.slice(0, top), [
    { key: "key", label: "project", max: 32 },
    { key: "messages", label: "msgs", align: "r", fmt: fmtNum },
    ...tokenCols,
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
    { key: "messages", label: "msgs", align: "r", fmt: fmtNum },
    { key: "_tok", label: "tokens", align: "r", fmt: (_, row) => fmtNum(totalTokens(row)) },
    { key: "_hit", label: "hit", align: "r", fmt: (_, row) => fmtPct(cacheHitRate(row)) },
    { key: "toolCalls", label: "tools", align: "r", fmt: fmtNum },
    { key: "toolErrors", label: "errs", align: "r" },
    { key: "est", label: "est $", align: "r", fmt: (v, row) => fmtUsd(v, row.unknownModel) },
    { key: "reported", label: "reported $", align: "r", fmt: (v) => (v == null ? "-" : fmtUsd(v)) },
    { key: "linesAdded", label: "+/-", align: "r", fmt: (v, row) => (v == null ? "-" : `+${v}/-${row.linesRemoved}`) },
  ]);
}

function toolTable(rows) {
  return table(rows, [
    { key: "key", label: "tool", max: 40 },
    { key: "calls", label: "calls", align: "r", fmt: fmtNum },
    { key: "errors", label: "errs", align: "r" },
    { key: "_rate", label: "err%", align: "r", fmt: (_, r) => fmtPct(r.calls ? r.errors / r.calls : 0) },
    { key: "resultChars", label: "out chars", align: "r", fmt: fmtNum },
    { key: "_avg", label: "avg", align: "r", fmt: (_, r) => fmtNum(r.calls ? r.resultChars / r.calls : 0) },
    { key: "maxResultChars", label: "max", align: "r", fmt: fmtNum },
    { key: "noResult", label: "no result", align: "r" },
  ]);
}

function renderTools(r, top) {
  return heading("Tools") + "\n" + toolTable(r.byTool.slice(0, top));
}

/** Round-robin across finding kinds so the summary shows variety, not eight of the same. */
function interleaveByKind(findings, n) {
  const buckets = new Map();
  for (const f of findings) (buckets.get(f.kind) || buckets.set(f.kind, []).get(f.kind)).push(f);
  const out = [];
  while (out.length < n) {
    let took = false;
    for (const b of buckets.values()) {
      if (b.length && out.length < n) { out.push(b.shift()); took = true; }
    }
    if (!took) break;
  }
  return out;
}

function wasteTable(rows) {
  return table(rows, [
    { key: "severity", label: "sev" },
    { key: "kind", label: "kind" },
    { key: "tool", label: "tool", max: 28 },
    { key: "count", label: "n", align: "r" },
    { key: "chars", label: "chars", align: "r", fmt: fmtNum },
    { key: "project", label: "project", max: 18 },
    { key: "sessionId", label: "session", fmt: (v) => short(v) },
    { key: "detail", label: "detail", max: 60 },
  ]);
}

function renderWaste(r, top) {
  if (!r.waste.length) return heading("Waste") + "\nnothing flagged";
  const parts = [heading(`Waste (${r.waste.length} findings)`), wasteTable(r.waste.slice(0, top))];
  const hints = new Map();
  for (const f of r.waste) hints.set(f.kind, f.hint);
  parts.push("\nHints");
  for (const [k, h] of hints) parts.push(`  ${k.padEnd(13)} ${truncate(h, 110)}`);
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

function footer(r) {
  const m = r.meta;
  const range = [r.range.since ? `since ${new Date(r.range.since).toLocaleDateString("sv-SE")}` : "all time", r.range.project ? `project~"${r.range.project}"` : null]
    .filter(Boolean)
    .join(", ");
  return `\n${m.files} files · ${fmtNum(m.lines)} lines · ${range} · parsed in ${m.parseMs}ms · ${m.dir.replace(os.homedir(), "~")}`;
}
