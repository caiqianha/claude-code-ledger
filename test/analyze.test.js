import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listSessionFiles, iterRecords } from "../src/loader.js";
import { buildModel, describeInput } from "../src/parse.js";
import { loadPricing, resolvePrice, costOf } from "../src/pricing.js";
import { analyze, totalTokens } from "../src/analyze.js";
import { parseSince } from "../src/cli.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, "fixtures");

async function load() {
  const model = await buildModel(iterRecords(listSessionFiles(fixtures)));
  return { model, report: analyze(model, { pricing: loadPricing() }) };
}

test("streaming-split messages are counted once", async () => {
  const { model, report } = await load();
  assert.equal(model.messages.size, 8);
  assert.equal(report.totals.messages, 8);
  // msg_1 usage counted once: input 10, not 20
  const t = report.totals;
  assert.equal(t.input, 10 + 5 * 7);
  assert.equal(t.cacheWrite, 2000);
});

test("malformed lines are skipped", async () => {
  const { model } = await load();
  assert.ok(model.stats.lines >= 18);
});

test("tool calls joined with results and errors", async () => {
  const { report } = await load();
  const bash = report.byTool.find((t) => t.key === "Bash");
  const read = report.byTool.find((t) => t.key === "Read");
  assert.equal(read.calls, 4);
  assert.equal(bash.calls, 3);
  assert.equal(bash.errors, 1);
  assert.equal(bash.maxResultChars, 40_000);
});

test("waste detectors fire", async () => {
  const { report } = await load();
  const kinds = report.waste.map((f) => f.kind);
  assert.ok(kinds.includes("repeat"), "repeat");
  assert.ok(kinds.includes("retry"), "retry");
  assert.ok(kinds.includes("large-output"), "large-output");
  const rep = report.waste.find((f) => f.kind === "repeat");
  assert.equal(rep.count, 4);
  assert.equal(rep.tool, "Read");
});

test("reported cost uses the last cost-state per session", async () => {
  const { report } = await load();
  assert.equal(report.reported.usd, 1.5);
  assert.equal(report.bySession[0].linesAdded, 12);
});

test("unknown model flags estimate instead of silently dropping", async () => {
  const { report } = await load();
  assert.equal(report.totals.unknownModel, true);
  const fut = report.byModel.find((m) => m.key === "claude-future-9");
  assert.ok(fut && fut.unknownModel);
  const opus = report.byModel.find((m) => m.key === "claude-opus-5-5");
  assert.ok(opus.est > 0 && !opus.unknownModel);
});

test("session metadata", async () => {
  const { report } = await load();
  const s = report.bySession[0].session;
  assert.equal(s.project, "demo-app");
  assert.equal(s.humanTurns, 1);
  assert.equal(s.compactions, 1);
  assert.ok(totalTokens(report.bySession[0]) > 0);
});

test("pricing resolution", () => {
  const p = loadPricing();
  assert.ok(resolvePrice(p, "claude-opus-5-5"));
  assert.ok(resolvePrice(p, "claude-sonnet-4-5-20250929"), "date suffix stripped");
  assert.ok(resolvePrice(p, "claude-haiku-4-5-20251001"), "prefix match");
  assert.equal(resolvePrice(p, "gpt-9"), null);
  const usd = costOf({ input: 1e6, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, thinking: 0 }, p["claude-opus-5-5"]);
  assert.equal(usd, 4);
});

test("describeInput keys are stable and short", () => {
  const a = describeInput("Bash", { command: "ls   -la\n" });
  const b = describeInput("Bash", { command: "ls -la" });
  assert.equal(a.key, b.key);
  assert.ok(describeInput("Foo", { z: 1, a: 2 }).key === describeInput("Foo", { a: 2, z: 1 }).key);
});

test("parseSince", () => {
  const now = Date.parse("2026-10-10T12:00:00");
  assert.equal(parseSince("1d", now), now - 86_400_000);
  assert.equal(parseSince("2w", now), now - 14 * 86_400_000);
  assert.equal(parseSince(undefined, now), undefined);
  assert.throws(() => parseSince("nope", now));
});
