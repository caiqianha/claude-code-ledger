/**
 * Gemini CLI chat recordings: ~/.gemini/tmp/<project-hash>/chats/session-<timestamp>-<shortid>.jsonl
 * (subagents under chats/<parent-session-id>/<id>.jsonl; older builds wrote one JSON document
 * `session-*.json` with the same ConversationRecord shape).
 *
 * Based on gemini-cli 0.65 (main branch, 2026-10) packages/core/src/services/chatRecordingTypes.ts:
 *   line 1          {sessionId, projectHash, startTime, lastUpdated, kind: "main"|"subagent", directories}
 *   message lines   {id, timestamp, type: "user"|"gemini"|"info"|"error"|"warning", content: PartListUnion,
 *                    toolCalls?: [{id, name, args, result, status, timestamp}], tokens?: {input, output, cached,
 *                    thoughts, tool, total}, model?}
 *   wrappers        {$set: {...metadata}} | {$patch: {id, content?, toolCalls: [{id, result}]}} | {$rewindTo: id}
 *
 * Gemini's `input` (promptTokenCount) includes cached tokens, so `cached` is split out as cacheRead.
 * `thoughts` are billed as output. When a gemini message has no `tokens`, usage is estimated from
 * text length (chars/4) and flagged as such.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { walkFiles, iterJsonl, normalizeInput, textChars, parseTs, estimateTokens } from "./common.js";
import { baseName } from "../parse.js";

export function geminiTmpDir() {
  const home = process.env.GEMINI_CLI_HOME || os.homedir();
  return path.join(home, ".gemini", "tmp");
}

export const gemini = {
  name: "gemini",
  label: "Gemini CLI",
  location: "~/.gemini/tmp/<project-hash>/chats/session-*.jsonl",
  defaultDirs: () => [geminiTmpDir()],
  listFiles: (dirs) =>
    dirs.flatMap((d) =>
      walkFiles(d, (f) => /[\\/]chats[\\/]/.test(f) && /\.jsonl?$/.test(f) && !/\.unreadable-/.test(f)).map((file) => ({ file, projectDir: path.basename(path.dirname(path.dirname(file))) })),
    ),
  async *read(entries) {
    for (const { file, projectDir } of entries) yield* readChat(file, projectDir);
  },
};

async function loadRecords(file) {
  if (file.endsWith(".json")) {
    try {
      const j = JSON.parse(fs.readFileSync(file, "utf8"));
      if (j && typeof j === "object") {
        const { messages, ...meta } = j;
        return [meta, ...(Array.isArray(messages) ? messages : [])];
      }
    } catch {
      /* unreadable legacy file */
    }
    return [];
  }
  const out = [];
  for await (const rec of iterJsonl(file)) out.push(rec);
  return out;
}

export async function* readChat(file, projectDir) {
  const recs = await loadRecords(file);
  let meta = {};
  const messages = [];
  const byId = new Map();
  for (const rec of recs) {
    if (rec.$set && typeof rec.$set === "object") {
      meta = { ...meta, ...rec.$set };
      if (Array.isArray(rec.$set.messages)) for (const m of rec.$set.messages) pushMsg(m);
      continue;
    }
    if (rec.$patch && typeof rec.$patch === "object") {
      applyPatch(rec.$patch);
      for (const u of rec.$patch.updates || []) applyPatch(u);
      continue;
    }
    if (rec.$rewindTo) continue; // best effort: keep everything that was recorded
    if (typeof rec.sessionId === "string" && !rec.type && !rec.content) {
      meta = { ...meta, ...rec };
      continue;
    }
    if (rec.type) pushMsg(rec);
  }
  function pushMsg(m) {
    if (!m || typeof m !== "object") return;
    if (m.id && byId.has(m.id)) return;
    messages.push(m);
    if (m.id) byId.set(m.id, m);
  }
  function applyPatch(p) {
    const m = p.id ? byId.get(p.id) : null;
    if (!m) return;
    if (p.content !== undefined) m.content = p.content;
    for (const tc of p.toolCalls || []) {
      const t = (m.toolCalls || []).find((x) => x.id === tc.id);
      if (t && tc.result !== undefined) t.result = tc.result;
    }
  }

  const sid = meta.sessionId || path.basename(file).replace(/\.jsonl?$/, "");
  const cwd = Array.isArray(meta.directories) && meta.directories[0] ? meta.directories[0] : null;
  const base = { agent: "gemini", sessionId: sid, cwd, project: cwd ? baseName(cwd) : meta.projectHash ? `gemini:${String(meta.projectHash).slice(0, 8)}` : projectDir || "gemini", projectDir, file, sidechain: meta.kind === "subagent" };
  const started = parseTs(meta.startTime);
  if (started !== null) yield { ...base, kind: "meta", ts: started };

  let ctxChars = 0; // running estimate of the context when tokens are not recorded
  let n = 0;
  for (const m of messages) {
    const ts = parseTs(m.timestamp);
    const chars = textChars(m.content);
    if (m.type === "user") {
      ctxChars += chars;
      yield { ...base, kind: "message", role: "user", ts, humanTurn: true };
      continue;
    }
    if (m.type !== "gemini") {
      yield { ...base, kind: "meta", ts };
      continue;
    }
    n++;
    const calls = Array.isArray(m.toolCalls) ? m.toolCalls : [];
    const tk = m.tokens && typeof m.tokens === "object" ? m.tokens : null;
    let usage;
    let estimated = false;
    if (tk) {
      const cached = Math.min(tk.cached || 0, tk.input || 0);
      usage = { input: (tk.input || 0) - cached, output: (tk.output || 0) + (tk.thoughts || 0), cacheRead: cached, cacheWrite5m: 0, cacheWrite1h: 0, thinking: tk.thoughts || 0 };
    } else {
      estimated = true;
      usage = { input: estimateTokens(ctxChars), output: estimateTokens(chars + calls.reduce((s, c) => s + textChars(c.args), 0)), cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, thinking: 0 };
    }
    ctxChars += chars;
    const toolCalls = calls
      .filter((c) => c && (c.id || c.name))
      .map((c, i) => ({ id: c.id || `${m.id || n}:${i}`, name: c.name || "unknown", input: normalizeInput(c.name, c.args), inputChars: textChars(c.args), ts: parseTs(c.timestamp) ?? ts }));
    const turn = { ...base, kind: "message", role: "assistant", id: m.id || `${sid}:${n}`, ts, model: m.model || "gemini-unknown", usage, toolCalls };
    if (estimated) turn.estimated = true;
    yield turn;
    const results = [];
    for (let i = 0; i < calls.length; i++) {
      const c = calls[i];
      if (!c || !(c.id || c.name)) continue;
      const rc = textChars(c.result ?? c.resultDisplay);
      ctxChars += rc;
      results.push({ toolUseId: toolCalls[results.length]?.id ?? c.id, isError: c.status === "error", chars: rc, ts: parseTs(c.timestamp) ?? ts });
    }
    if (results.length) yield { ...base, kind: "message", role: "user", ts: results[0].ts ?? ts, toolResults: results };
  }
}
