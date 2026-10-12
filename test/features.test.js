import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { listSessionFiles, iterRecords } from "../src/loader.js";
import { buildModel } from "../src/parse.js";
import { loadPricing } from "../src/pricing.js";
import { analyze, epochOf } from "../src/analyze.js";
import { advise } from "../src/advise.js";
import { mergeReports } from "../src/merge.js";
import { renderHtml } from "../src/report.js";
import { main } from "../src/cli.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, "fixtures");

async function load() {
  const model = await buildModel(iterRecords(listSessionFiles(fixtures)));
  return { model, report: analyze(model, { pricing: loadPricing() }) };
}

test("compaction splits repeat groups", async () => {
  const { model, report } = await load();
  const s = [...model.sessions.values()][0];
  assert.equal(s.compactions.length, 2);
  assert.equal(epochOf(s.compactions, Date.parse("2026-10-01T10:00:00Z")), 0);
  assert.equal(epochOf(s.compactions, Date.parse("2026-10-01T11:30:00Z")), 2);
  const reps = report.waste.filter((f) => f.kind === "repeat" && f.tool === "Read");
  assert.equal(reps.length, 1, "post-compaction reads (2) must not join the pre-compaction group (4)");
  assert.equal(reps[0].count, 4);
});

test("subagent spend is tracked separately", async () => {
  const { report } = await load();
  assert.ok(report.totals.sub > 0);
  assert.ok(report.totals.sub < report.totals.est);
  const haiku = report.byModel.find((m) => m.key === "claude-haiku-5-5");
  assert.equal(haiku.sub, haiku.est);
  // sidechain text does not count as a human turn
  assert.equal(report.bySession[0].session.humanTurns, 1);
});

test("context cost attribution: earlier results cost more than the last", async () => {
  const { report } = await load();
  const read = report.byTool.find((t) => t.key === "Read");
  assert.ok(read.ctxCost > 0);
  assert.ok(report.totals.ctxCost > 0);
  const ctx = report.byContext.find((k) => k.key.includes("src/a.js"));
  assert.ok(ctx && ctx.calls === 6);
  // the 40k Bash output must be the single most expensive context item
  assert.equal(report.byContext[0].tool, "Bash");
});

test("reported cost is apportioned across days", async () => {
  const { report } = await load();
  const days = report.byDay.filter((d) => d.reported != null);
  assert.ok(days.length >= 2);
  const sum = days.reduce((n, d) => n + d.reported, 0);
  assert.ok(Math.abs(sum - 1.5) < 1e-9);
});

test("tool latency is derived from timestamps", async () => {
  const { report } = await load();
  const read = report.byTool.find((t) => t.key === "Read");
  assert.ok(read.msCount >= 2 && read.msTotal > 0);
});

test("advise produces a CLAUDE.md block", async () => {
  const { report } = await load();
  const md = advise(report, { days: 7 });
  assert.match(md, /^## Token hygiene/);
  assert.match(md, /src\/a\.js/);
  assert.match(md, /npm test/);
});

test("merge adds totals and keeps keyed rows", async () => {
  const { report } = await load();
  const plain = JSON.parse(JSON.stringify(report, (k, v) => (k === "session" ? { id: v.id, project: v.project, firstTs: v.firstTs, lastTs: v.lastTs, humanTurns: v.humanTurns } : v)));
  const m = mergeReports([plain, plain]);
  assert.equal(m.totals.messages, report.totals.messages * 2);
  assert.equal(m.byTool.find((t) => t.key === "Bash").calls, 6);
  assert.equal(m.byTool.find((t) => t.key === "Bash").maxResultChars, 40_000);
  assert.equal(m.bySession.length, 2);
  assert.ok(Math.abs(m.reported.usd - 3) < 1e-9);
});

test("html report renders with chart and no raw content", async () => {
  const { report } = await load();
  report.meta = { files: 1, lines: 10 };
  const html = renderHtml(report);
  assert.match(html, /<svg/);
  assert.match(html, /<path d="M/);
  assert.ok(!html.includes("xxxxxxxx"), "tool output must never appear");
  assert.match(html, /prefers-color-scheme:dark/);
});

test("cli: json output and hook line", async () => {
  const chunks = [];
  const io = { stdout: { write: (s) => chunks.push(s), isTTY: false }, stderr: process.stderr, stdin: { isTTY: true } };
  await main(["summary", "--dir", fixtures, "--json"], io);
  const j = JSON.parse(chunks.join(""));
  assert.equal(j.sessionsIncluded, 1);
  assert.ok(Array.isArray(j.byContext));
  chunks.length = 0;
  await main(["hook", "--dir", fixtures, "--session", "11111111"], io);
  assert.match(chunks.join(""), /^ccledger: \$/);
});

test("cli: report writes an html file", async () => {
  const out = path.join(os.tmpdir(), `ccledger-test-${process.pid}.html`);
  const io = { stdout: { write: () => {}, isTTY: false }, stderr: process.stderr, stdin: { isTTY: true } };
  await main(["report", "--dir", fixtures, "--out", out], io);
  assert.ok(fs.statSync(out).size > 5000);
  fs.unlinkSync(out);
});

test("cli: statusline from stdin json and from --session", async () => {
  const chunks = [];
  const transcript = path.join(fixtures, "-Users-demo-code-demo-app", "11111111-2222-3333-4444-555555555555.jsonl");
  const payload = {
    session_id: "11111111-2222-3333-4444-555555555555",
    transcript_path: transcript,
    model: { id: "claude-opus-5-5", display_name: "Opus" },
    cost: { total_cost_usd: 1.5 },
    context_window: { context_window_size: 200000, current_usage: { input_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 59000 } },
  };
  const stdin = Object.assign((async function* () { yield JSON.stringify(payload); })(), { isTTY: false });
  const io = { stdout: { write: (s) => chunks.push(s), isTTY: false }, stderr: process.stderr, stdin };
  process.env.NO_COLOR = "1";
  await main(["statusline", "--no-cache"], io);
  const line = chunks.join("");
  assert.match(line, /^Opus · \$1\.50 · ctx 60\.0k 30% · \d+ calls/);
  assert.match(line, /⚠ (repeat|cold-cache)/);
  chunks.length = 0;
  // second run uses the incremental cache and must give the same tool counts
  const io2 = { stdout: { write: (s) => chunks.push(s), isTTY: false }, stderr: process.stderr, stdin: { isTTY: true } };
  await main(["statusline", "--dir", fixtures, "--session", "11111111"], io2);
  await main(["statusline", "--dir", fixtures, "--session", "11111111"], io2);
  const [a, b] = chunks;
  assert.equal(a, b);
  assert.match(a, /calls/);
  delete process.env.NO_COLOR;
});
