import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ingestTurns } from "../src/parse.js";
import { loadPricing } from "../src/pricing.js";
import { analyze, totalTokens } from "../src/analyze.js";
import { AGENTS, resolveAgents, locate, readAll } from "../src/agents/index.js";
import { normalizeInput } from "../src/agents/common.js";
import { hasSqlite3 } from "../src/agents/cursor.js";
import { renderHtml } from "../src/report.js";
import { main } from "../src/cli.js";
import { tmpDir } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FX = path.join(here, "fixtures-agents");
const pricing = loadPricing();

async function run(agent, dir) {
  const { sources, notes } = locate(resolveAgents(agent), [dir]);
  const model = await ingestTurns(readAll(sources));
  return { model, report: analyze(model, { pricing }), notes, files: sources.flatMap((s) => s.entries).length };
}

function cursorDir() {
  const dir = path.join(tmpDir("ccledger-cursor-"), "User");
  fs.mkdirSync(path.join(dir, "globalStorage"), { recursive: true });
  const ws = path.join(dir, "workspaceStorage", "abcdef0123456789");
  fs.mkdirSync(ws, { recursive: true });
  execFileSync("sqlite3", [path.join(dir, "globalStorage", "state.vscdb")], { input: fs.readFileSync(path.join(FX, "cursor", "global.sql")) });
  execFileSync("sqlite3", [path.join(ws, "state.vscdb")], { input: fs.readFileSync(path.join(FX, "cursor", "workspace.sql")) });
  fs.copyFileSync(path.join(FX, "cursor", "workspace.json"), path.join(ws, "workspace.json"));
  return dir;
}

test("resolveAgents", () => {
  assert.deepEqual(resolveAgents(undefined).map((a) => a.name), ["claude"]);
  assert.deepEqual(resolveAgents("all").map((a) => a.name), ["claude", "codex", "gemini", "cursor"]);
  assert.deepEqual(resolveAgents("codex,gemini").map((a) => a.name), ["codex", "gemini"]);
  assert.throws(() => resolveAgents("copilot"), /Unknown --agent/);
  for (const a of Object.values(AGENTS)) assert.ok(a.location && a.label && typeof a.listFiles === "function");
});

test("normalizeInput maps foreign tool inputs onto Claude-style keys without keeping text", () => {
  assert.deepEqual(normalizeInput("shell", { command: ["bash", "-lc", "ls -la"], workdir: "/x" }), { command: "bash -lc ls -la" });
  assert.deepEqual(normalizeInput("read_file", { absolute_path: "/a/b.ts", offset: 10, limit: 20 }), { file_path: "/a/b.ts", offset: 10, limit: 20 });
  assert.deepEqual(normalizeInput("read_file_v2", JSON.stringify({ targetFile: "/a/c.ts", charsLimit: 1 })), { file_path: "/a/c.ts" });
  assert.deepEqual(normalizeInput("apply_patch", "*** Begin Patch\n*** Update File: src/x.js\n+1\n*** End Patch"), { file_path: "src/x.js" });
  assert.deepEqual(normalizeInput("weird", { secret_text: "do not keep me", n: 1 }), { keys: "n,secret_text" });
});

test("codex: a rollout without token_count events still counts, with estimated usage", async () => {
  const dir = path.join(tmpDir("ccledger-codex-est-"), "2026", "10", "06");
  fs.mkdirSync(dir, { recursive: true });
  const t = (n) => `2026-10-06T10:00:${String(n).padStart(2, "0")}.000Z`;
  const recs = [
    { timestamp: t(0), type: "session_meta", payload: { id: "11111111-2222-4333-8444-555555555555", timestamp: t(0), cwd: "/home/demo/code/tiny", cli_version: "0.115.0" } },
    { timestamp: t(0), type: "turn_context", payload: { cwd: "/home/demo/code/tiny", model: "gpt-5.1-codex" } },
    { timestamp: t(1), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "please rename the helper and keep the tests green" }] } },
    { timestamp: t(2), type: "event_msg", payload: { type: "task_started" } },
    { timestamp: t(3), type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "x".repeat(800) }] } },
    { timestamp: t(4), type: "event_msg", payload: { type: "task_complete" } },
  ];
  fs.writeFileSync(path.join(dir, "rollout-2026-10-06T10-00-00-11111111-2222-4333-8444-555555555555.jsonl"), recs.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const { report } = await run("codex", path.dirname(path.dirname(path.dirname(dir))));
  assert.equal(report.sessionsIncluded, 1, "session is not dropped");
  assert.equal(report.totals.messages, 1);
  assert.equal(report.totals.output, 200, "800 chars / 4");
  assert.ok(report.totals.input > 0);
  assert.ok(report.bySession[0].estimated, "flagged as estimated");
});

test("codex: rollout file is normalized (tokens from token_count deltas, tools joined by call_id)", async () => {
  const { model, report, files } = await run("codex", path.join(FX, "codex"));
  assert.equal(files, 1);
  assert.equal(report.sessionsIncluded, 1);
  const ss = report.bySession[0];
  assert.equal(ss.session.agent, "codex");
  assert.equal(ss.session.project, "sample-service");
  assert.equal(ss.session.version, "0.115.0");
  assert.equal(ss.session.humanTurns, 2, "developer / <environment_context> messages are not human turns");
  assert.equal(ss.session.compactions.length, 1);
  assert.equal(report.totals.messages, 10, "one message per token_count event");
  assert.equal(report.totals.input, 15100);
  assert.equal(report.totals.cacheRead, 40900);
  assert.equal(report.totals.output, 1390);
  assert.equal(report.totals.thinking, 420);
  assert.equal(report.totals.toolCalls, 11);
  assert.equal(report.totals.toolErrors, 3);
  assert.ok(report.totals.est > 0 && !report.totals.unknownModel, "gpt-5.1-codex is priced");
  const shell = report.byTool.find((t) => t.key === "shell");
  assert.equal(shell.calls, 9);
  assert.equal(shell.maxResultChars > 45000, true);
  assert.ok(report.byTool.find((t) => t.key === "local_shell"));
  assert.ok(report.byTool.find((t) => t.key === "apply_patch"));
  const kinds = report.waste.map((f) => f.kind);
  assert.ok(kinds.includes("repeat") && kinds.includes("retry") && kinds.includes("large-output"));
  const rep = report.waste.find((f) => f.kind === "repeat");
  assert.equal(rep.count, 4, "the post-compaction repeat is a separate epoch");
  assert.match(rep.detail, /sed -n '1,200p' src\/handler\.js/);
  assert.equal(report.waste.find((f) => f.kind === "retry").count, 1);
  assert.equal(model.stats.lines > 30, true);
});

test("gemini: jsonl + patches + legacy json + subagent", async () => {
  const { report, files } = await run("gemini", path.join(FX, "gemini"));
  assert.equal(files, 3);
  assert.equal(report.sessionsIncluded, 3);
  const main = report.bySession.find((s) => s.session.id === "cccccccc-dddd-4eee-8fff-000000000001");
  assert.equal(main.session.agent, "gemini");
  assert.equal(main.session.project, "sample-site");
  assert.equal(main.messages, 3);
  assert.equal(main.estimated, true, "a message without tokens is estimated");
  assert.equal(report.totals.estimated, true);
  assert.equal(report.byModel.find((m) => m.key === "gemini-2.5-pro").input, 3000 + 2000, "cached tokens split out of input");
  assert.equal(report.byModel.find((m) => m.key === "gemini-2.5-pro").cacheRead, 21000);
  assert.ok(report.totals.sub > 0, "subagent file is a sidechain");
  const legacy = report.bySession.find((s) => s.session.id.startsWith("eeeeeeee"));
  assert.equal(legacy.messages, 1);
  const read = report.byTool.find((t) => t.key === "read_file");
  assert.equal(read.calls, 4);
  const sh = report.byTool.find((t) => t.key === "run_shell_command");
  assert.equal(sh.errors, 1, "error status survives the $patch");
  const kinds = report.waste.map((f) => f.kind);
  assert.ok(kinds.includes("repeat") && kinds.includes("retry") && kinds.includes("large-output"), kinds.join());
  assert.equal(report.waste.find((f) => f.kind === "repeat").tool, "read_file");
});

test("cursor: sqlite via sqlite3 CLI, tokens estimated, no pricing", { skip: !hasSqlite3() && "sqlite3 CLI not installed" }, async () => {
  const dir = cursorDir();
  const { report, files, notes } = await run("cursor", dir);
  assert.equal(notes.length, 0);
  assert.equal(files, 2);
  assert.equal(report.sessionsIncluded, 3, "two composers with bubbles + one legacy chat tab; the empty draft is skipped");
  const s1 = report.bySession.find((s) => s.session.id.startsWith("11111111"));
  assert.equal(s1.session.agent, "cursor");
  assert.equal(s1.session.project, "sample-app");
  assert.equal(s1.noPricing, true);
  assert.equal(s1.est, 0);
  assert.equal(s1.unknownModel, false, "unpriced agents are not reported as unknown models");
  assert.equal(s1.estimated, true);
  assert.ok(s1.input >= 5000, "the recorded tokenCount is used when present");
  assert.equal(report.totals.noPricing, true);
  const s2 = report.bySession.find((s) => s.session.id.startsWith("66666666"));
  assert.equal(s2.session.project, "other-app", "composer mapped to its workspace folder");
  const legacy = report.bySession.find((s) => s.session.id.startsWith("legacy:"));
  assert.ok(legacy && legacy.messages === 1);
  assert.equal(report.byTool.find((t) => t.key === "read_file_v2").calls, 4);
  assert.equal(report.byTool.find((t) => t.key === "run_terminal_command_v2").errors, 1);
  const kinds = report.waste.map((f) => f.kind);
  assert.ok(kinds.includes("repeat") && kinds.includes("retry") && kinds.includes("large-output"), kinds.join());
  const html = renderHtml(report);
  assert.match(html, /n\/a/);
  assert.ok(!html.includes("please add logging"), "message text never reaches the report");
});

test("cursor: missing database directory yields no files, not an error", async () => {
  const { files, notes } = await run("cursor", path.join(tmpDir(), "nowhere"));
  assert.equal(files, 0);
  assert.equal(notes.length, 0);
});

test("cli: --agent all merges every fixture source and shows an agent column", { skip: !hasSqlite3() && "sqlite3 CLI not installed" }, async () => {
  const env = { CCLEDGER_DIR: process.env.CCLEDGER_DIR, CODEX_HOME: process.env.CODEX_HOME, GEMINI_CLI_HOME: process.env.GEMINI_CLI_HOME, CURSOR_USER_DIR: process.env.CURSOR_USER_DIR, NO_COLOR: process.env.NO_COLOR };
  const codexHome = tmpDir("ccledger-codex-");
  fs.cpSync(path.join(FX, "codex"), path.join(codexHome, "sessions"), { recursive: true });
  const gemHome = tmpDir("ccledger-gem-");
  fs.cpSync(path.join(FX, "gemini"), path.join(gemHome, ".gemini", "tmp"), { recursive: true });
  process.env.CCLEDGER_DIR = path.join(here, "fixtures");
  process.env.CODEX_HOME = codexHome;
  process.env.GEMINI_CLI_HOME = gemHome;
  process.env.CURSOR_USER_DIR = cursorDir();
  process.env.NO_COLOR = "1";
  try {
    const chunks = [];
    const io = { stdout: { write: (s) => chunks.push(s), isTTY: false }, stderr: { write: () => {} }, stdin: { isTTY: true } };
    await main(["summary", "--agent", "all"], io);
    const out = chunks.join("");
    assert.match(out, /By agent/);
    for (const a of ["claude", "codex", "gemini", "cursor"]) assert.match(out, new RegExp(`^${a}\\s`, "m"));
    assert.match(out, /agents: claude, codex, gemini, cursor/);
    chunks.length = 0;
    await main(["sessions", "--agent", "all", "--json"], io);
    const j = JSON.parse(chunks.join(""));
    assert.equal(j.byAgent.length, 4);
    assert.deepEqual(j.meta.agents, ["claude", "codex", "gemini", "cursor"]);
    assert.ok(j.bySession.some((s) => s.session.agent === "codex"));
    chunks.length = 0;
    await main(["sessions", "--agent", "all"], io);
    assert.match(chunks.join(""), /\bagent\b/);
    chunks.length = 0;
    // single-agent Claude JSON keeps its old shape
    await main(["summary", "--json"], io);
    const k = JSON.parse(chunks.join(""));
    assert.equal(k.byAgent, undefined);
    assert.equal(k.meta.agents, undefined);
    assert.ok(!("patterns" in k));
  } finally {
    for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

test("cli: --help lists every agent location", async () => {
  const chunks = [];
  await main(["--help"], { stdout: { write: (s) => chunks.push(s), isTTY: false }, stderr: process.stderr, stdin: { isTTY: true } });
  const h = chunks.join("");
  for (const a of Object.values(AGENTS)) assert.ok(h.includes(a.location), a.name);
  assert.match(h, /--budget/);
  assert.match(h, /compare/);
  assert.match(h, /--claude-md/);
});
