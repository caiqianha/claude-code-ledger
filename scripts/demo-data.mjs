#!/usr/bin/env node
/**
 * Generate a synthetic Claude Code log directory for demos, screenshots and tests.
 * Nothing here comes from a real session. Deterministic for a given seed.
 *
 *   node scripts/demo-data.mjs [outDir] [--seed 7] [--days 14]
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const args = process.argv.slice(2);
const flag = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const outDir = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--seed" && args[args.indexOf(a) - 1] !== "--days") || path.join(os.tmpdir(), "ccledger-demo");
const seed = Number(flag("--seed", 7));
const days = Number(flag("--days", 14));

let s = seed >>> 0;
const rnd = () => ((s = (s + 0x6d2b79f5) >>> 0), ((Math.imul(s ^ (s >>> 15), 1 | s) ^ 0) >>> 0) / 4294967296);
const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const pick = (arr) => arr[int(0, arr.length - 1)];
const hex = (n) => Array.from({ length: n }, () => "0123456789abcdef"[int(0, 15)]).join("");
const uuid = () => `${hex(8)}-${hex(4)}-4${hex(3)}-${pick("89ab")}${hex(3)}-${hex(12)}`;

const expand = (dirs, names, ext) => dirs.flatMap((d) => names.map((n) => `${d}/${n}.${ext}`));
const PROJECTS = [
  { name: "web-app", files: ["package.json", "vite.config.js", "src/router/index.js", ...expand(["src/store/modules", "src/api", "src/utils"], ["order", "payment", "user", "cart", "coupon", "refund", "address", "auth"], "js"), ...expand(["src/views/checkout", "src/views/orders", "src/components"], ["index", "Summary", "ItemList", "AddressForm"], "vue")] },
  { name: "api-server", files: ["go.mod", "Makefile", "migrations/0042_refunds.sql", ...expand(["internal/handler", "internal/service", "internal/repo"], ["order", "billing", "refund", "webhook", "user", "auth", "invoice"], "go"), ...expand(["internal/handler", "internal/service"], ["order_test", "billing_test", "refund_test"], "go")] },
  { name: "docs-site", files: ["sidebars.js", "docusaurus.config.js", ...expand(["docs", "docs/api", "docs/guides"], ["getting-started", "webhooks", "authentication", "pagination", "errors", "rate-limits", "sdks"], "md")] },
];
const MODELS = ["claude-opus-5-5", "claude-opus-5-5", "claude-opus-5-5", "claude-sonnet-5-5"];
const CMDS = ["npm test 2>&1 | tail -20", "git status --short", "git diff --stat", "go test ./...", "npm run lint", "ls -la src/", "git log --oneline -10", "cat package.json | head -40", "make build", "npx vitest run src/store", "go vet ./...", "git diff HEAD~1 -- src/api", "npm run build 2>&1 | tail -5", "grep -rn TODO src | head", "sed -n '1,80p' internal/service/billing.go", "curl -s localhost:8080/health", "git stash list", "node scripts/check.js", "pnpm -v && node -v", "ls docs/api"];

const SCENARIOS = ["normal", "repeat-read", "normal", "huge-output", "retry", "normal", "error-prone", "cold-cache", "normal"];
const PRICE = { "claude-opus-5-5": [4, 20, 0.2, 8], "claude-sonnet-5-5": [2, 10, 0.2, 4], "claude-haiku-5-5": [0.1, 0.5, 0.01, 0.2] };

fs.rmSync(outDir, { recursive: true, force: true });
const now = Date.now();
let sessionsWritten = 0;

for (const proj of PROJECTS) {
  const dir = path.join(outDir, `-Users-demo-code-${proj.name}`);
  fs.mkdirSync(dir, { recursive: true });
  const nSessions = int(4, 7);
  for (let si = 0; si < nSessions; si++) {
    const sid = uuid();
    const start = now - int(1, days * 24 - 2) * 3_600_000 - int(0, 3_599_000);
    const base = { cwd: `/Users/demo/code/${proj.name}`, sessionId: sid, version: "2.1.0", gitBranch: pick(["main", "feat/refunds", "fix/checkout-total", "docs/webhooks"]), entrypoint: "cli", userType: "external", isSidechain: false };
    const lines = [];
    let t = start;
    let ctx = int(15_000, 40_000);
    let cost = 0;
    let i = 0;
    const emit = (o) => lines.push(JSON.stringify(o));
    const tick = (ms) => (t += ms, new Date(t).toISOString());
    const usageFor = (model, out, extraWrite = 0) => {
      const input = int(2, 40);
      const write = extraWrite + (rnd() < 0.3 ? int(500, 4000) : 0);
      const read = ctx;
      ctx += write + input + out;
      const [pi, po, pr, pw] = PRICE[model];
      cost += (input * pi + out * po + read * pr + write * pw) / 1e6;
      return {
        input_tokens: input, output_tokens: out, cache_read_input_tokens: read, cache_creation_input_tokens: write,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: write },
        output_tokens_details: { thinking_tokens: Math.floor(out * rnd() * 0.5) }, service_tier: "standard",
      };
    };
    const user = (content) => emit({ ...base, type: "user", uuid: "u" + i++, parentUuid: null, timestamp: tick(int(2_000, 90_000)), message: { role: "user", content } });
    const assistant = (model, content, usage) => {
      const id = "msg_" + hex(24);
      // mimic streaming: text/thinking block and tool_use block land on separate lines with identical usage
      const blocks = content.filter(Boolean);
      for (const b of blocks) emit({ ...base, type: "assistant", uuid: "a" + i++, requestId: "req_" + hex(16), timestamp: tick(int(1_500, 25_000)), message: { id, model, role: "assistant", type: "message", content: [b], stop_reason: b.type === "tool_use" ? "tool_use" : "end_turn", usage } });
    };
    const toolCall = (model, name, input, resultChars, isError = false) => {
      const tuid = "toolu_" + hex(24);
      assistant(model, [rnd() < 0.5 ? { type: "thinking", thinking: "", signature: "" } : null, { type: "tool_use", id: tuid, name, input }], usageFor(model, int(60, 400)));
      ctx += Math.floor(resultChars / 4);
      user([{ type: "tool_result", tool_use_id: tuid, is_error: isError || undefined, content: isError ? "Error: " + "e".repeat(int(40, 200)) : "x".repeat(resultChars) }]);
    };

    const scenario = SCENARIOS[(sessionsWritten + si) % SCENARIOS.length];
    const turns = int(5, 18);
    const model = pick(MODELS);
    const hotFile = pick(proj.files);

    for (let turn = 0; turn < turns; turn++) {
      user("(prompt text omitted in demo data)");
      const steps = int(2, 7);
      for (let st = 0; st < steps; st++) {
        const r = rnd();
        if (r < 0.35) toolCall(model, "Bash", { command: rnd() < 0.7 ? pick(CMDS) : `git log --oneline -${int(3, 30)}`, description: "demo" }, int(80, 6_000), rnd() < 0.05);
        else if (r < 0.6) toolCall(model, "Read", { file_path: `${base.cwd}/${pick(proj.files)}` }, int(1_500, 20_000));
        else if (r < 0.75) toolCall(model, "Edit", { file_path: `${base.cwd}/${pick(proj.files)}`, old_string: "a", new_string: "b" }, int(100, 300));
        else if (r < 0.85) toolCall(model, "Grep", { pattern: pick(["TODO", "refund", "handleSubmit", "webhook"]), path: base.cwd }, int(200, 9_000));
        else if (r < 0.92) toolCall(model, "Glob", { pattern: "**/*.test.js" }, int(100, 2_000));
        else toolCall(model, "mcp__playwright__browser_snapshot", { filename: `step-${turn}-${st}.png` }, int(2_000, 6_000), rnd() < 0.08);
      }
      if (scenario === "repeat-read" && turn % 2 === 0) for (let k = 0; k < 2; k++) toolCall(model, "Read", { file_path: `${base.cwd}/${hotFile}` }, int(6_000, 9_000));
      if (scenario === "huge-output" && turn === 2) toolCall(model, "Bash", { command: "npm test 2>&1", description: "demo" }, int(45_000, 70_000));
      if (scenario === "retry" && turn === 1) { toolCall(model, "Bash", { command: "docker compose up -d" }, 300, true); toolCall(model, "Bash", { command: "docker compose up -d" }, 300, true); toolCall(model, "Bash", { command: "docker compose up -d" }, 1200); }
      if (scenario === "error-prone" && turn < 4) for (let k = 0; k < 3; k++) toolCall(model, "mcp__github__search_issues", { q: `is:open label:bug page:${turn * 3 + k}` }, 400, k !== 2);
      if (scenario === "cold-cache") { ctx = int(2_000, 6_000); assistant(model, [{ type: "text", text: "" }], { input_tokens: int(60_000, 120_000), output_tokens: int(300, 900), cache_read_input_tokens: int(0, 8_000), cache_creation_input_tokens: int(20_000, 40_000) }); cost += 0.4; }
      // occasional haiku sub-call (e.g. title generation)
      if (rnd() < 0.15) assistant("claude-haiku-5-5", [{ type: "text", text: "" }], { input_tokens: int(300, 900), output_tokens: int(5, 30), cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
      assistant(model, [{ type: "text", text: "" }], usageFor(model, int(150, 1_800)));
      if (rnd() < 0.15) t += int(1, 3) * 3_600_000; // coffee break
    }
    if (rnd() < 0.2) emit({ ...base, type: "system", subtype: "compact_boundary", timestamp: tick(1000), content: "" });
    if (rnd() < 0.9) emit({ type: "cost-state", sessionId: sid, totalCostUSD: +(cost * (0.93 + rnd() * 0.1)).toFixed(4), totalAPIDuration: int(200_000, 3_000_000), totalToolDuration: int(20_000, 400_000), totalDuration: t - start, totalLinesAdded: int(20, 1500), totalLinesRemoved: int(0, 400), startTime: start, modelUsage: [model, "claude-haiku-5-5"], hasUnknownModelCost: false });
    fs.writeFileSync(path.join(dir, `${sid}.jsonl`), lines.join("\n") + "\n");
    sessionsWritten++;
  }
}
console.log(`wrote ${sessionsWritten} synthetic sessions to ${outDir}`);
console.log(`try: CCLEDGER_DIR=${outDir} ccledger`);
