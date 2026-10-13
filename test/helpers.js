/* Synthetic Claude Code session writer for tests. Nothing here comes from a real log. */
import fs from "node:fs";
import path from "node:path";

let counter = 0;

/**
 * Write one synthetic session into <dir>/-Users-demo-code-<project>/<id>.jsonl.
 * steps: array of
 *   { tool, input, chars?, error?, gapSec? }   a tool call + result
 *   { usage: {...} }                           an assistant message with explicit usage
 *   { compaction: true }
 * Every assistant message carries small default usage so costs and cache rates are defined.
 */
export function writeSession(dir, { project = "demo-app", id, start = Date.parse("2026-10-01T10:00:00Z"), model = "claude-opus-5-5", steps = [], usage = {}, costState } = {}) {
  const sid = id || `${String(++counter).padStart(8, "0")}-0000-4000-8000-000000000000`;
  const pdir = path.join(dir, `-Users-demo-code-${project}`);
  fs.mkdirSync(pdir, { recursive: true });
  const base = { cwd: `/Users/demo/code/${project}`, sessionId: sid, version: "2.1.0", gitBranch: "main" };
  const lines = [];
  let t = start;
  const ts = (sec = 60) => new Date((t += sec * 1000)).toISOString();
  const u0 = { input_tokens: 20, output_tokens: 40, cache_read_input_tokens: 3000, cache_creation_input_tokens: 200, ...usage };
  lines.push(JSON.stringify({ ...base, type: "user", uuid: `u-${sid}-0`, timestamp: ts(0), message: { role: "user", content: "hello" } }));
  let n = 0;
  for (const st of steps) {
    n++;
    if (st.compaction) {
      lines.push(JSON.stringify({ ...base, type: "system", subtype: "compact_boundary", timestamp: ts(st.gapSec ?? 60) }));
      continue;
    }
    const u = { ...u0, ...(st.usage || {}) };
    const content = st.tool ? [{ type: "tool_use", id: `tu-${sid}-${n}`, name: st.tool, input: st.input || {} }] : [{ type: "text", text: "ok" }];
    lines.push(JSON.stringify({ ...base, type: "assistant", uuid: `a-${sid}-${n}`, timestamp: ts(st.gapSec ?? 60), message: { id: `msg-${sid}-${n}`, model: st.model || model, role: "assistant", content, usage: u } }));
    if (st.tool) lines.push(JSON.stringify({ ...base, type: "user", uuid: `r-${sid}-${n}`, timestamp: ts(5), message: { role: "user", content: [{ type: "tool_result", tool_use_id: `tu-${sid}-${n}`, is_error: !!st.error, content: "x".repeat(st.chars ?? 500) }] } }));
  }
  if (costState) lines.push(JSON.stringify({ type: "cost-state", sessionId: sid, totalDuration: 1000, ...costState }));
  const file = path.join(pdir, `${sid}.jsonl`);
  fs.writeFileSync(file, lines.join("\n") + "\n");
  return { file, sid, end: t };
}

export function tmpDir(prefix = "ccledger-test-") {
  return fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", prefix));
}
