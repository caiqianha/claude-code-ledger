#!/usr/bin/env node
/**
 * Regenerates the synthetic fixtures for the Codex / Gemini CLI / Cursor readers.
 * Everything here is made up; no record comes from a real session.
 *   node test/fixtures-agents/generate.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const X = (n, ch = "x") => ch.repeat(n);

// ---------------- Codex rollout (mirrors the RolloutLine {timestamp,type,payload} shape) ----------------
const sid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const cwd = "/home/demo/code/sample-service";
let t = Date.parse("2026-10-05T09:00:00Z");
const ts = (sec) => new Date((t += sec * 1000)).toISOString();
const L = [];
const line = (type, payload, o = 0) => L.push(JSON.stringify({ timestamp: ts(o), type, payload }));
let tot = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0 };
const tokenCount = (input, cached, output, reasoning = 0) => {
  tot = { input_tokens: tot.input_tokens + input, cached_input_tokens: tot.cached_input_tokens + cached, output_tokens: tot.output_tokens + output, reasoning_output_tokens: tot.reasoning_output_tokens + reasoning, total_tokens: tot.total_tokens + input + output };
  line("event_msg", { type: "token_count", info: { total_token_usage: { ...tot }, last_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: reasoning, total_tokens: input + output }, model_context_window: 272000 }, rate_limits: null }, 5);
};
let callN = 0;
const call = (name, args, output, { outSec = 3 } = {}) => {
  const id = `call_${String(++callN).padStart(3, "0")}`;
  line("response_item", { type: "function_call", name, arguments: JSON.stringify(args), call_id: id }, 10);
  line("response_item", { type: "function_call_output", call_id: id, output }, outSec);
  return id;
};
line("session_meta", { id: sid, timestamp: ts(0), cwd, originator: "codex_cli_rs", cli_version: "0.115.0", source: "cli", model_provider: "openai", git: { branch: "main", commit_hash: "0000000000000000000000000000000000000000" }, base_instructions: { text: "placeholder" } });
line("turn_context", { cwd, approval_policy: "on-request", sandbox_policy: { type: "workspace-write" }, model: "gpt-5.1-codex", effort: "medium", summary: "auto", turn_id: "turn-1" });
line("event_msg", { type: "task_started", turn_id: "turn-1", model_context_window: 272000 });
line("response_item", { type: "message", role: "developer", content: [{ type: "input_text", text: "<developer_instructions>placeholder</developer_instructions>" }] });
line("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>placeholder</environment_context>" }, { type: "input_text", text: "please fix the failing test" }] });
line("response_item", { type: "reasoning", summary: [{ type: "summary_text", text: "thinking" }], content: null, encrypted_content: "REDACTED" });
for (let i = 0; i < 4; i++) {
  // 4x identical read-like shell command -> repeat
  call("shell", { command: ["bash", "-lc", "sed -n '1,200p' src/handler.js"], workdir: cwd }, JSON.stringify({ output: X(1500, "h"), metadata: { exit_code: 0, duration_seconds: 0.1 } }));
  tokenCount(2000 + i * 400, 1800 + i * 400, 120, 40);
}
// failing test, retried unchanged -> retry
call("shell", { command: ["bash", "-lc", "npm test"] }, JSON.stringify({ output: "1 failing", metadata: { exit_code: 1, duration_seconds: 2.2 } }));
tokenCount(3800, 3500, 200, 80);
call("shell", { command: ["bash", "-lc", "npm test"] }, JSON.stringify({ output: "1 failing", metadata: { exit_code: 1, duration_seconds: 2.1 } }));
tokenCount(4000, 3800, 200, 80);
// older text envelope for error detection
call("shell", { command: ["bash", "-lc", "cat missing.txt"] }, "Exit code: 1\nWall time: 0.0 seconds\nOutput:\ncat: missing.txt: No such file or directory");
tokenCount(4100, 4000, 50);
// huge output -> large-output
call("shell", { command: ["bash", "-lc", "cat build.log"] }, JSON.stringify({ output: X(45000, "y"), metadata: { exit_code: 0, duration_seconds: 0.3 } }));
tokenCount(16000, 4000, 100);
// local_shell_call + custom_tool_call apply_patch
L.push(JSON.stringify({ timestamp: ts(10), type: "response_item", payload: { type: "local_shell_call", call_id: "call_ls1", status: "completed", action: { type: "exec", command: ["ls", "-la"], timeout_ms: 1000 } } }));
line("response_item", { type: "function_call_output", call_id: "call_ls1", output: X(800, "l") }, 2);
line("response_item", { type: "custom_tool_call", call_id: "call_p1", name: "apply_patch", status: "completed", input: "*** Begin Patch\n*** Update File: src/handler.js\n@@\n-old\n+new\n*** End Patch" }, 5);
line("response_item", { type: "custom_tool_call_output", call_id: "call_p1", output: "Success. Updated the following files:\nM src/handler.js" }, 2);
tokenCount(16500, 16000, 300, 100);
line("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "Fixed." }] }, 2);
line("event_msg", { type: "agent_message", message: "Fixed." });
line("event_msg", { type: "task_complete", turn_id: "turn-1", last_agent_message: "Fixed." });
L.push("this line is not json");
L.push(JSON.stringify({ timestamp: ts(60), type: "compacted", payload: { message: "summary placeholder" } }));
L.push(JSON.stringify({ timestamp: ts(5), type: "event_msg", payload: { type: "item_completed", item: { type: "UserMessage", content: [{ type: "text", text: "second request" }] } } }));
line("turn_context", { cwd, approval_policy: "on-request", sandbox_policy: { type: "workspace-write" }, model: "gpt-5.1-codex", effort: "medium", turn_id: "turn-2" });
line("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "second request" }] });
call("shell", { command: ["bash", "-lc", "sed -n '1,200p' src/handler.js"] }, JSON.stringify({ output: X(1500, "h"), metadata: { exit_code: 0 } }));
tokenCount(1200, 0, 60);
line("event_msg", { type: "token_count", info: null, rate_limits: { primary: { used_percent: 12 } } }); // rate-limit refresh without usage: ignored
line("event_msg", { type: "task_complete", turn_id: "turn-2", last_agent_message: null });
const codexDir = path.join(here, "codex", "2026", "10", "05");
fs.mkdirSync(codexDir, { recursive: true });
fs.writeFileSync(path.join(codexDir, `rollout-2026-10-05T09-00-00-${sid}.jsonl`), L.join("\n") + "\n");

// ---------------- Gemini CLI chat recording (chatRecordingTypes.ts shape) ----------------
const hash = "0f".repeat(32);
const gdir = path.join(here, "gemini", hash, "chats");
const gsid = "cccccccc-dddd-4eee-8fff-000000000001";
fs.mkdirSync(path.join(gdir, gsid), { recursive: true });
const G = [];
let gt = Date.parse("2026-10-06T10:00:00Z");
const gts = (sec) => new Date((gt += sec * 1000)).toISOString();
G.push(JSON.stringify({ sessionId: gsid, projectHash: hash, startTime: gts(0), lastUpdated: gts(0), kind: "main", directories: ["/home/demo/code/sample-site"] }));
G.push(JSON.stringify({ id: "m1", timestamp: gts(1), type: "user", content: [{ text: "add a sitemap" }] }));
const readCalls = [];
for (let i = 0; i < 4; i++) readCalls.push({ id: `tc-read-${i}`, name: "read_file", args: { absolute_path: "/home/demo/code/sample-site/src/routes.ts" }, result: [{ functionResponse: { name: "read_file", response: { output: X(2000, "r") } } }], status: "success", timestamp: gts(2) });
G.push(JSON.stringify({ id: "m2", timestamp: gts(1), type: "gemini", content: [{ text: "Reading the routes." }], toolCalls: readCalls, tokens: { input: 12000, output: 300, cached: 9000, thoughts: 150, tool: 0, total: 12450 }, model: "gemini-2.5-pro" }));
G.push(JSON.stringify({ id: "m3", timestamp: gts(5), type: "gemini", content: [{ text: "Running tests." }], toolCalls: [{ id: "tc-sh-1", name: "run_shell_command", args: { command: "npm test" }, result: null, status: "error", timestamp: gts(1) }, { id: "tc-sh-2", name: "run_shell_command", args: { command: "npm test" }, result: [{ functionResponse: { name: "run_shell_command", response: { output: "ok" } } }], status: "success", timestamp: gts(20) }], tokens: { input: 14000, output: 200, cached: 12000, thoughts: 0, tool: 0, total: 14200 }, model: "gemini-2.5-pro" }));
G.push(JSON.stringify({ $patch: { id: "m3", toolCalls: [{ id: "tc-sh-1", result: [{ functionResponse: { name: "run_shell_command", response: { error: "1 failing" } } }] }] } }));
G.push(JSON.stringify({ id: "m4", timestamp: gts(5), type: "info", content: "Compressing context" }));
G.push(JSON.stringify({ id: "m5", timestamp: gts(5), type: "gemini", content: [{ text: X(4000, "g") }], toolCalls: [{ id: "tc-big", name: "run_shell_command", args: { command: "cat dist/bundle.js" }, result: [{ functionResponse: { name: "run_shell_command", response: { output: X(50000, "b") } } }], status: "success", timestamp: gts(3) }], model: "gemini-2.5-flash" })); // no tokens -> estimated
G.push("{not json");
G.push(JSON.stringify({ $set: { lastUpdated: gts(1), summary: "placeholder" } }));
G.push(JSON.stringify({ $rewindTo: "m5" }));
fs.writeFileSync(path.join(gdir, "session-2026-10-06T10-00-cccccccc.jsonl"), G.join("\n") + "\n");
fs.writeFileSync(
  path.join(gdir, gsid, "dddddddd-0000-4000-8000-000000000002.jsonl"),
  [
    JSON.stringify({ sessionId: "dddddddd-0000-4000-8000-000000000002", projectHash: hash, startTime: gts(1), lastUpdated: gts(0), kind: "subagent", directories: ["/home/demo/code/sample-site"] }),
    JSON.stringify({ id: "s1", timestamp: gts(1), type: "user", content: "sub task" }),
    JSON.stringify({ id: "s2", timestamp: gts(1), type: "gemini", content: "done", tokens: { input: 500, output: 50, cached: 0, total: 550 }, model: "gemini-2.5-flash" }),
  ].join("\n") + "\n",
);
fs.writeFileSync(
  path.join(gdir, "session-2026-09-01T08-00-eeeeeeee.json"),
  JSON.stringify({ sessionId: "eeeeeeee-0000-4000-8000-000000000003", projectHash: hash, startTime: "2026-09-01T08:00:00.000Z", lastUpdated: "2026-09-01T08:05:00.000Z", messages: [{ id: "l1", timestamp: "2026-09-01T08:00:01.000Z", type: "user", content: "hi" }, { id: "l2", timestamp: "2026-09-01T08:00:05.000Z", type: "gemini", content: "hello", tokens: { input: 100, output: 10, cached: 0, total: 110 }, model: "gemini-2.5-flash" }] }),
);

// ---------------- Cursor seed SQL (tests turn this into a SQLite db with the sqlite3 CLI) ----------------
const cdir = path.join(here, "cursor");
fs.mkdirSync(cdir, { recursive: true });
const cid = "11111111-2222-4333-8444-555555555555";
const bub = (i, extra, base = "2026-10-07T14:00:00Z") => JSON.stringify({ _v: 3, bubbleId: `b${i}`, createdAt: new Date(Date.parse(base) + i * 30000).toISOString(), ...extra });
const rows = [];
rows.push([`composerData:${cid}`, JSON.stringify({ _v: 12, composerId: cid, createdAt: Date.parse("2026-10-07T14:00:00Z"), lastUpdatedAt: Date.parse("2026-10-07T14:20:00Z"), modelConfig: { modelName: "demo-model-x" }, workspaceIdentifier: { id: "w1", uri: { fsPath: "/home/demo/code/sample-app", scheme: "file" } }, fullConversationHeadersOnly: [{ bubbleId: "b0", type: 1 }], totalLinesAdded: 10, totalLinesRemoved: 2, status: "completed" })]);
rows.push([`bubbleId:${cid}:b0`, bub(0, { type: 1, text: "please add logging", tokenCount: { inputTokens: 5000, outputTokens: 0 } })]);
for (let i = 1; i <= 4; i++) rows.push([`bubbleId:${cid}:b${i}`, bub(i, { type: 2, text: "", toolFormerData: { name: "read_file_v2", status: "completed", params: JSON.stringify({ targetFile: "/home/demo/code/sample-app/src/index.ts", charsLimit: 20000 }), result: JSON.stringify({ contents: X(3000, "c"), totalLinesInFile: 100 }), toolCallId: `t${i}` }, tokenCount: { inputTokens: 0, outputTokens: 0 } })]);
rows.push([`bubbleId:${cid}:b5`, bub(5, { type: 2, text: "", toolFormerData: { name: "run_terminal_command_v2", status: "error", params: JSON.stringify({ command: "npm run build" }), result: "error: failed", toolCallId: "t5" }, tokenCount: { inputTokens: 0, outputTokens: 0 } })]);
rows.push([`bubbleId:${cid}:b6`, bub(6, { type: 2, text: "", toolFormerData: { name: "run_terminal_command_v2", status: "completed", params: JSON.stringify({ command: "npm run build" }), result: X(40000, "o"), toolCallId: "t6" }, tokenCount: { inputTokens: 0, outputTokens: 0 } })]);
rows.push([`bubbleId:${cid}:b7`, bub(7, { type: 2, text: X(1200, "a"), modelInfo: { modelName: "demo-model-x" }, tokenCount: { inputTokens: 0, outputTokens: 0 } })]);
rows.push([`bubbleId:${cid}:b8`, "not json at all"]);
const cid2 = "66666666-7777-4888-8999-aaaaaaaaaaaa"; // no workspace path: mapped through the workspace db
rows.push([`composerData:${cid2}`, JSON.stringify({ _v: 12, composerId: cid2, createdAt: Date.parse("2026-10-08T09:00:00Z"), lastUpdatedAt: Date.parse("2026-10-08T09:05:00Z"), modelConfig: { modelName: "demo-model-y" }, fullConversationHeadersOnly: [{ bubbleId: "b0", type: 1 }, { bubbleId: "b1", type: 2 }] })]);
rows.push([`bubbleId:${cid2}:b0`, bub(0, { type: 1, text: "hello" }, "2026-10-08T09:00:00Z")]);
rows.push([`bubbleId:${cid2}:b1`, bub(1, { type: 2, text: X(400, "z") }, "2026-10-08T09:00:00Z")]);
rows.push(["composerData:77777777-0000-4000-8000-000000000000", JSON.stringify({ _v: 12, composerId: "77777777-0000-4000-8000-000000000000", createdAt: Date.parse("2026-10-08T09:00:00Z"), fullConversationHeadersOnly: [] })]); // draft, no bubbles -> skipped
const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
fs.writeFileSync(
  path.join(cdir, "global.sql"),
  ["CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);", "CREATE TABLE IF NOT EXISTS cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);", ...rows.map(([k, v]) => `INSERT INTO cursorDiskKV (key, value) VALUES (${q(k)}, ${q(v)});`)].join("\n") + "\n",
);
fs.writeFileSync(
  path.join(cdir, "workspace.sql"),
  [
    "CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);",
    `INSERT INTO ItemTable (key, value) VALUES ('composer.composerData', ${q(JSON.stringify({ allComposers: [{ type: "head", composerId: cid2, createdAt: Date.parse("2026-10-08T09:00:00Z"), unifiedMode: "agent" }], selectedComposerIds: [cid2] }))});`,
    `INSERT INTO ItemTable (key, value) VALUES ('workbench.panel.aichat.view.aichat.chatdata', ${q(JSON.stringify({ tabs: [{ tabId: "tab-legacy-1", chatTitle: "placeholder", lastSendTime: Date.parse("2026-09-20T12:00:00Z"), bubbles: [{ type: "user", text: "old chat question" }, { type: "ai", text: X(600, "q"), modelType: "demo-model-legacy" }] }] }))});`,
    `INSERT INTO ItemTable (key, value) VALUES ('aiService.prompts', '[{"text":"placeholder","commandType":4}]');`,
  ].join("\n") + "\n",
);
fs.writeFileSync(path.join(cdir, "workspace.json"), JSON.stringify({ folder: "file:///home/demo/code/other-app" }) + "\n");
console.log("fixtures written under", here);
