import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listSessionFiles, iterRecords } from "../src/loader.js";
import { buildModel } from "../src/parse.js";
import { loadPricing } from "../src/pricing.js";
import { analyze } from "../src/analyze.js";
import { claudeMdRules, claudeMdBlock, CLAUDE_MD_THRESHOLDS } from "../src/advise.js";
import { formatBudget, budgetLevel, parseBudget } from "../src/budget.js";
import { windows, compare, metricsOf, renderCompare, durationMs, sessionCount } from "../src/compare.js";
import { setColor } from "../src/render.js";
import { main } from "../src/cli.js";
import { writeSession, tmpDir } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const pricing = loadPricing();
const DAY = 86_400_000;

async function reportOf(dir, opts = {}) {
  const model = await buildModel(iterRecords(listSessionFiles(dir)));
  return { model, report: analyze(model, { pricing, ...opts }) };
}
const read = (f, extra = {}) => ({ tool: "Read", input: { file_path: `/Users/demo/code/demo-app/${f}` }, ...extra });
const grep = (p, extra = {}) => ({ tool: "Grep", input: { pattern: p, path: "/Users/demo/code/demo-app" }, ...extra });
const bash = (cmd, extra = {}) => ({ tool: "Bash", input: { command: cmd }, ...extra });

/* ---------------- advise --claude-md ---------------- */

test("claude-md: no rules on a clean session", async () => {
  const dir = tmpDir();
  writeSession(dir, { steps: [read("a.js"), read("b.js"), bash("npm test"), grep("foo")] });
  const { report } = await reportOf(dir);
  assert.deepEqual(claudeMdRules(report), []);
  assert.match(claudeMdBlock(report), /No pattern crossed its threshold/);
});

test("claude-md: re-read rule with evidence", async () => {
  const dir = tmpDir();
  const steps = [];
  for (let i = 0; i < 12; i++) steps.push(read(`f${i}.js`));
  for (let i = 0; i < 4; i++) steps.push(read("f0.js")); // 4 of 16 reads are re-reads = 25%
  writeSession(dir, { steps });
  const { report } = await reportOf(dir);
  const rules = claudeMdRules(report);
  const r = rules.find((x) => x.id === "reread");
  assert.ok(r, JSON.stringify(rules));
  assert.match(r.rule, /already in context/);
  assert.match(r.evidence, /25% of file reads \(4 of 16\)/);
  assert.match(r.evidence, /f0\.js/);
  const md = claudeMdBlock(report, { days: 7 });
  assert.match(md, /^<!-- ccledger suggestions/);
  assert.match(md, /## Working rules/);
  assert.match(md, /How to apply/);
  assert.match(md, /- Before reading a file[\s\S]*\n  - evidence: 25%/);
});

test("claude-md: repeated searches and repeated shell commands", async () => {
  const dir = tmpDir();
  const steps = [];
  for (let i = 0; i < 10; i++) steps.push(grep(`pat${i}`));
  for (let i = 0; i < 3; i++) steps.push(grep("pat0"));
  for (let i = 0; i < 10; i++) steps.push(bash(`echo ${i}`));
  for (let i = 0; i < 3; i++) steps.push(bash("git status"));
  for (let i = 0; i < 2; i++) steps.push(bash("echo 0"));
  writeSession(dir, { steps });
  const { report } = await reportOf(dir);
  const ids = claudeMdRules(report).map((r) => r.id);
  assert.ok(ids.includes("research"), ids.join());
  assert.ok(ids.includes("reshell"), ids.join());
  assert.ok(!ids.includes("reread"));
});

test("claude-md: retry rule needs ≥2 identical retries", async () => {
  const dir = tmpDir();
  writeSession(dir, { steps: [bash("make", { error: true }), bash("make", { error: true }), bash("make")] });
  const { report } = await reportOf(dir);
  const r = claudeMdRules(report).find((x) => x.id === "retry");
  assert.ok(r);
  assert.match(r.evidence, /2 identical retries/);
  assert.match(r.evidence, /`make` ×2/);
  const dir2 = tmpDir();
  writeSession(dir2, { steps: [bash("make", { error: true }), bash("make")] });
  assert.equal(claudeMdRules((await reportOf(dir2)).report).find((x) => x.id === "retry"), undefined);
});

test("claude-md: large-output rule names the tool and the largest result", async () => {
  const dir = tmpDir();
  writeSession(dir, { steps: [bash("cat big.log", { chars: 60_000 }), bash("npm run build", { chars: 35_000 }), read("x.js")] });
  const { report } = await reportOf(dir);
  const r = claudeMdRules(report).find((x) => x.id === "large-output");
  assert.ok(r);
  assert.match(r.rule, /head/);
  assert.match(r.evidence, /2 tool results exceeded 30\.0k characters/);
  assert.match(r.evidence, /largest 60\.0k chars/);
  assert.match(r.evidence, /Bash ×2/);
});

test("claude-md: error-prone and cold-cache rules", async () => {
  const dir = tmpDir();
  const steps = [];
  for (let i = 0; i < 10; i++) steps.push({ tool: "mcp__db__query", input: { sql: `q${i}` }, error: i % 2 === 0 });
  steps.push({ usage: { input_tokens: 400_000, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 100_000 } });
  writeSession(dir, { steps });
  const { report } = await reportOf(dir);
  const rules = claudeMdRules(report);
  const ep = rules.find((x) => x.id === "error-prone:mcp__db__query");
  assert.ok(ep, rules.map((r) => r.id).join());
  assert.match(ep.evidence, /50% of the time \(5 of 10 calls\)/);
  assert.ok(rules.find((x) => x.id === "cold-cache"));
  assert.equal(CLAUDE_MD_THRESHOLDS.errorMinCalls, 10);
});

test("cli: advise --claude-md --out writes the block", async () => {
  const dir = tmpDir();
  const steps = [];
  for (let i = 0; i < 12; i++) steps.push(read(`f${i}.js`));
  for (let i = 0; i < 4; i++) steps.push(read("f0.js"));
  writeSession(dir, { steps });
  const out = path.join(dir, "CLAUDE.suggestions.md");
  const chunks = [];
  const io = { stdout: { write: (s) => chunks.push(s), isTTY: false }, stderr: process.stderr, stdin: { isTTY: true } };
  await main(["advise", "--claude-md", "--dir", dir, "--out", out], io);
  assert.match(chunks.join(""), /Suggestions written to .*CLAUDE\.suggestions\.md \(1 rules\)/);
  assert.match(fs.readFileSync(out, "utf8"), /## Working rules/);
  chunks.length = 0;
  await main(["advise", "--claude-md", "--dir", dir], io);
  assert.match(chunks.join(""), /evidence: 25% of file reads/);
  chunks.length = 0;
  await main(["advise", "--dir", dir], io); // classic block unchanged
  assert.match(chunks.join(""), /^## Token hygiene/);
});

/* ---------------- budget ---------------- */

test("budget: thresholds and formatting", () => {
  setColor(false);
  assert.equal(parseBudget("20"), 20);
  assert.equal(parseBudget("$12.5"), 12.5);
  assert.equal(parseBudget("nope"), null);
  assert.equal(parseBudget(0), null);
  assert.equal(budgetLevel(5, 20), "ok");
  assert.equal(budgetLevel(16, 20), "warn");
  assert.equal(budgetLevel(15.99, 20), "ok");
  assert.equal(budgetLevel(20, 20), "alert");
  assert.equal(budgetLevel(1, null), null);
  assert.equal(formatBudget(5, 20), "today $5.00/$20 25%");
  assert.equal(formatBudget(16, 20), "today $16.0/$20 80% ⚠");
  assert.equal(formatBudget(21, 20), "today $21.0/$20 105% ⚠ over");
  assert.equal(formatBudget(1, 2.5, { prefix: "" }), "$1.00/$2.50 40%");
  assert.equal(formatBudget(1, null), null);
  setColor(true);
  assert.equal(formatBudget(5, 20), "today $5.00/$20 25%", "ok level has no color");
  assert.equal(formatBudget(16, 20), "\x1b[33mtoday $16.0/$20 80% ⚠\x1b[0m");
  assert.equal(formatBudget(40, 20), "\x1b[31mtoday $40.0/$20 200% ⚠ over\x1b[0m");
  setColor(false);
});

test("statusline and today show today's spend against --budget", async () => {
  const dir = tmpDir();
  const now = Date.now();
  const start = new Date(now);
  start.setHours(1, 0, 0, 0);
  // 100 messages × 1M input tokens of opus-5-5 at $4/M = $400 today
  const { file } = writeSession(dir, { start: start.getTime(), steps: Array.from({ length: 100 }, () => ({ usage: { input_tokens: 1_000_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 } })) });
  fs.utimesSync(file, new Date(), new Date());
  const old = process.env.NO_COLOR;
  process.env.NO_COLOR = "1";
  try {
    const chunks = [];
    const io = { stdout: { write: (s) => chunks.push(s), isTTY: false }, stderr: process.stderr, stdin: { isTTY: true } };
    await main(["statusline", "--dir", dir, "--no-cache", "--budget", "500"], io);
    assert.match(chunks.join(""), /today \$400\/\$500 80% ⚠/);
    chunks.length = 0;
    await main(["statusline", "--dir", dir, "--no-cache", "--budget", "300"], io);
    assert.match(chunks.join(""), /today \$400\/\$300 133% ⚠ over/);
    chunks.length = 0;
    await main(["statusline", "--dir", dir, "--no-cache"], io);
    assert.doesNotMatch(chunks.join(""), /today/);
    chunks.length = 0;
    await main(["today", "--dir", dir, "--budget", "1000"], io);
    const out = chunks.join("");
    assert.match(out, /Today \(/);
    assert.match(out, /budget\s+\$400\/\$1000 40%/);
    assert.match(out, /spend\s+\$400 est/);
    chunks.length = 0;
    await main(["today", "--dir", dir], io);
    assert.match(chunks.join(""), /none set/);
  } finally {
    if (old === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = old;
  }
});

test("budget from config file", async () => {
  const cfgHome = tmpDir("ccledger-cfg-");
  fs.mkdirSync(path.join(cfgHome, "ccledger"));
  fs.writeFileSync(path.join(cfgHome, "ccledger", "config.json"), JSON.stringify({ budget: 7 }));
  const dir = tmpDir();
  writeSession(dir, { start: Date.now() - 60_000, steps: [{ usage: {} }] });
  const prev = { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, NO_COLOR: process.env.NO_COLOR };
  process.env.XDG_CONFIG_HOME = cfgHome;
  process.env.NO_COLOR = "1";
  try {
    const chunks = [];
    await main(["today", "--dir", dir], { stdout: { write: (s) => chunks.push(s), isTTY: false }, stderr: process.stderr, stdin: { isTTY: true } });
    assert.match(chunks.join(""), /\/\$7 \d+%/);
  } finally {
    for (const [k, v] of Object.entries(prev)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

/* ---------------- compare ---------------- */

function wastefulAndClean(dir, now) {
  // baseline: 3 wasteful sessions 10-12 days ago; after: 3 clean sessions 1-3 days ago
  for (let i = 0; i < 3; i++) {
    const steps = [];
    for (let k = 0; k < 5; k++) steps.push(read("hot.js", { chars: 4000 }));
    steps.push(bash("cat log", { chars: 50_000 }), bash("make", { error: true }), bash("make"));
    writeSession(dir, { start: now - (10 + i) * DAY, steps, usage: { cache_read_input_tokens: 500, input_tokens: 5000 } });
  }
  for (let i = 0; i < 3; i++) {
    writeSession(dir, { start: now - (1 + i) * DAY, steps: [read("a.js"), read("b.js"), bash("npm test")], usage: { cache_read_input_tokens: 9000, input_tokens: 50 } });
  }
}

test("compare: default windows, deltas and verdict", async () => {
  const dir = tmpDir();
  const now = Date.now();
  wastefulAndClean(dir, now);
  const { model } = await reportOf(dir);
  const w = windows(model, { now });
  assert.equal(w.after.until - w.after.since, 7 * DAY);
  assert.equal(w.before.until, w.after.since - 1);
  assert.equal(w.before.since, w.after.since - 7 * DAY);
  const cmp = compare(model, pricing, { after: w.after, before: w.before });
  assert.equal(cmp.before.metrics.sessions, 3);
  assert.equal(cmp.after.metrics.sessions, 3);
  assert.ok(cmp.before.metrics.wasteRate > cmp.after.metrics.wasteRate);
  assert.ok(cmp.before.metrics.cacheHit < cmp.after.metrics.cacheHit);
  assert.ok(cmp.before.metrics.costPerSession > cmp.after.metrics.costPerSession);
  assert.match(cmp.verdict, /^Better: /);
  assert.match(cmp.verdict, /waste rate -\d+ pts/);
  assert.match(cmp.verdict, /\(3 vs 3 sessions\)/);
  const txt = renderCompare(cmp);
  assert.match(txt, /metric\s+before\s+after\s+delta/);
  assert.match(txt, /avg tokens \/ session/);
  // reversed: worse
  const rev = compare(model, pricing, { after: w.before, before: w.after });
  assert.match(rev.verdict, /^Worse/);
  // metrics helper
  const m = metricsOf(analyze(model, { pricing }));
  assert.equal(m.sessions, 6);
  assert.ok(m.wasteRate > 0 && m.wasteRate < 1);
});

test("compare: --baseline as duration or session count; empty windows", async () => {
  const dir = tmpDir();
  const now = Date.now();
  wastefulAndClean(dir, now);
  const { model } = await reportOf(dir);
  assert.equal(durationMs("30d"), 30 * DAY);
  assert.equal(sessionCount("20 sessions"), 20);
  assert.equal(sessionCount("7d"), null);
  const w1 = windows(model, { now, since: now - 5 * DAY, baseline: "30d" });
  assert.equal(w1.before.since, now - 35 * DAY);
  const w2 = windows(model, { now, since: now - 5 * DAY, baseline: "2 sessions" });
  assert.equal(w2.before.sessions, 2);
  const cmp2 = compare(model, pricing, { after: w2.after, before: w2.before });
  assert.equal(cmp2.before.metrics.sessions, 2);
  const w3 = windows(model, { now, since: now - 100 * DAY, until: now - 90 * DAY });
  const cmp3 = compare(model, pricing, { after: w3.after, before: w3.before });
  assert.match(cmp3.verdict, /^Not enough data/);
});

test("cli: compare --mark stores a marker and compares around it", async () => {
  const cfgHome = tmpDir("ccledger-cfg-");
  const dir = tmpDir();
  const now = Date.now();
  wastefulAndClean(dir, now);
  const prev = { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, NO_COLOR: process.env.NO_COLOR };
  process.env.XDG_CONFIG_HOME = cfgHome;
  process.env.NO_COLOR = "1";
  try {
    const chunks = [];
    const io = { stdout: { write: (s) => chunks.push(s), isTTY: false }, stderr: process.stderr, stdin: { isTTY: true } };
    await main(["compare", "--dir", dir, "--mark", "claude.md rules"], io);
    let out = chunks.join("");
    assert.match(out, /Marker "claude\.md rules" stored/);
    assert.match(out, /Not enough data: \d+ sessions? before, 0 after/);
    const state = JSON.parse(fs.readFileSync(path.join(cfgHome, "ccledger", "state.json"), "utf8"));
    assert.equal(state.markers.length, 1);
    // backdate the marker to 6 days ago so the clean sessions fall after it
    state.markers[0].ts = now - 6 * DAY;
    fs.writeFileSync(path.join(cfgHome, "ccledger", "state.json"), JSON.stringify(state));
    chunks.length = 0;
    await main(["compare", "--dir", dir, "--mark"], io); // bare --mark
    out = chunks.join("");
    assert.match(out, /before "claude\.md rules"/);
    assert.match(out, /after "claude\.md rules"/);
    assert.match(out, /^Better: /m);
    chunks.length = 0;
    await main(["compare", "--dir", dir, "--mark", "--json"], io);
    const j = JSON.parse(chunks.join(""));
    assert.equal(j.after.metrics.sessions, 3);
    chunks.length = 0;
    await main(["compare", "--dir", dir, "--since", "7d", "--baseline", "3 sessions"], io);
    assert.match(chunks.join(""), /\(3 sessions\)/);
  } finally {
    for (const [k, v] of Object.entries(prev)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

test("cli: compare --mark without a stored marker is a clear error", async () => {
  const cfgHome = tmpDir("ccledger-cfg-");
  const prev = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = cfgHome;
  try {
    await assert.rejects(main(["compare", "--dir", path.join(here, "fixtures"), "--mark"], { stdout: { write: () => {}, isTTY: false }, stderr: process.stderr, stdin: { isTTY: true } }), /No marker stored yet/);
  } finally {
    if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prev;
  }
});
