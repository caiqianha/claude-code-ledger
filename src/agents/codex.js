/**
 * OpenAI Codex CLI rollouts: ~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl
 * (or $CODEX_HOME/sessions). Format observed with Codex CLI 0.115 (2026-10); field names
 * cross-checked against codex-rs/protocol (RolloutLine = {timestamp, type, payload}).
 *
 * Record types used:
 *   session_meta   payload.{id, timestamp, cwd, cli_version, model_provider, source, git.branch}
 *   turn_context   payload.{model, cwd, turn_id}                      -> current model
 *   response_item  payload.type = message | function_call | function_call_output |
 *                  local_shell_call | custom_tool_call | custom_tool_call_output | compaction | reasoning …
 *   event_msg      payload.type = token_count {info.total_token_usage{input_tokens, cached_input_tokens,
 *                  output_tokens, reasoning_output_tokens, total_tokens}} | task_started | task_complete …
 *   compacted      context compaction boundary
 *
 * Token usage is taken from the *cumulative* total_token_usage deltas, so repeated token_count
 * events (rate-limit refreshes) are not double counted. OpenAI counts cached tokens inside
 * input_tokens; they are split out as cacheRead here so the cached price applies.
 */
import os from "node:os";
import path from "node:path";
import { walkFiles, iterJsonl, normalizeInput, textChars, estimateTokens, parseTs, tryJson } from "./common.js";
import { baseName } from "../parse.js";

export function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

function sessionIdFromFile(file) {
  const m = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(file);
  return m ? m[1] : path.basename(file, ".jsonl");
}

function usageOf(u) {
  if (!u || typeof u !== "object") return null;
  const input = u.input_tokens || 0;
  const cached = Math.min(u.cached_input_tokens || 0, input);
  return { input: input - cached, output: u.output_tokens || 0, cacheRead: cached, cacheWrite5m: 0, cacheWrite1h: 0, thinking: u.reasoning_output_tokens || 0, _write: u.cache_write_input_tokens || 0 };
}

function delta(now, prev) {
  const out = {};
  let any = false;
  for (const k of ["input", "output", "cacheRead", "thinking", "_write"]) {
    out[k] = Math.max(0, (now[k] || 0) - (prev?.[k] || 0));
    if (out[k]) any = true;
  }
  if (!any) return null;
  return { input: out.input, output: out.output, cacheRead: out.cacheRead, cacheWrite5m: out._write, cacheWrite1h: 0, thinking: out.thinking };
}

/** Exit status heuristics for shell outputs: new JSON envelope {output, metadata.exit_code} or the older "Exit code: N" text. */
function outputIsError(output) {
  if (output == null) return false;
  if (typeof output === "string") {
    const j = output.startsWith("{") ? tryJson(output) : null;
    if (j && typeof j === "object") {
      const code = j.metadata?.exit_code ?? j.exit_code;
      if (typeof code === "number") return code !== 0;
    }
    const m = /(?:^|\n)\s*exit code:\s*(-?\d+)/i.exec(output.slice(0, 400));
    if (m) return Number(m[1]) !== 0;
    return /^(error|failed|command failed|traceback|permission denied)/i.test(output.trimStart());
  }
  if (typeof output === "object" && output.success === false) return true;
  return false;
}

function humanText(content) {
  // Codex injects user-role messages such as <environment_context>, <user_instructions>, <turn_aborted>.
  if (!Array.isArray(content)) return typeof content === "string" && !content.trimStart().startsWith("<");
  return content.some((b) => b && typeof b.text === "string" && b.text.trim() && !b.text.trimStart().startsWith("<"));
}

export const codex = {
  name: "codex",
  label: "Codex CLI",
  location: "~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl",
  defaultDirs: () => [path.join(codexHome(), "sessions")],
  listFiles: (dirs) => dirs.flatMap((d) => walkFiles(d, (f) => /rollout-.*\.jsonl$/.test(path.basename(f))).map((file) => ({ file, projectDir: null }))),
  async *read(entries) {
    for (const { file } of entries) yield* readRollout(file);
  },
};

export async function* readRollout(file) {
  let sid = sessionIdFromFile(file);
  let cwd = null;
  let model = null;
  let version = null;
  let branch = null;
  let prevTotal = null;
  let pendingCalls = [];
  let pendingIn = 0; // chars of user/tool text since the last flush (estimate fallback)
  let pendingOut = 0; // chars of assistant text since the last flush (estimate fallback)
  let sawUsage = false; // once a token_count record exists, never fall back to estimates
  let n = 0;
  const base = () => ({ agent: "codex", sessionId: sid, cwd, project: cwd ? baseName(cwd) : "codex", projectDir: null, file, version, gitBranch: branch });
  const flush = (ts, usage, estimated) => {
    n++;
    const t = { ...base(), kind: "message", role: "assistant", id: `${sid}:${n}`, ts, model: model || "unknown", usage: usage || undefined, toolCalls: pendingCalls };
    if (estimated) t.estimated = true;
    pendingCalls = [];
    pendingIn = 0;
    pendingOut = 0;
    return t;
  };
  // Sessions recorded without token_count events (older CLIs, aborted turns) would otherwise vanish:
  // flush an estimated message from the text seen since the last real usage record.
  const flushEstimated = (ts) => {
    if (sawUsage) return pendingCalls.length ? flush(ts, null, false) : null;
    if (!pendingCalls.length && !pendingOut) return null;
    const usage = { input: estimateTokens(pendingIn), output: estimateTokens(pendingOut), cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, thinking: 0 };
    return flush(ts, usage, true);
  };

  for await (const rec of iterJsonl(file)) {
    const ts = parseTs(rec.timestamp);
    const p = rec.payload && typeof rec.payload === "object" ? rec.payload : {};
    switch (rec.type) {
      case "session_meta": {
        if (typeof p.id === "string") sid = p.id;
        if (typeof p.cwd === "string") cwd = p.cwd;
        version = p.cli_version || version;
        branch = p.git?.branch || branch;
        yield { ...base(), kind: "meta", ts: ts ?? parseTs(p.timestamp) };
        break;
      }
      case "turn_context": {
        if (typeof p.model === "string") model = p.model;
        if (typeof p.cwd === "string") cwd = p.cwd;
        yield { ...base(), kind: "meta", ts };
        break;
      }
      case "compacted":
        yield { ...base(), kind: "compaction", ts };
        break;
      case "response_item": {
        switch (p.type) {
          case "message":
            if (p.role === "user") {
              pendingIn += textChars(p.content);
              yield { ...base(), kind: "message", role: "user", ts, humanTurn: humanText(p.content) };
            } else {
              if (p.role === "assistant") pendingOut += textChars(p.content);
              yield { ...base(), kind: "meta", ts };
            }
            break;
          case "function_call":
          case "custom_tool_call":
          case "local_shell_call": {
            const id = p.call_id || p.id;
            if (!id) break;
            let name = p.name || (p.type === "local_shell_call" ? "local_shell" : "unknown");
            let raw = p.type === "function_call" ? tryJson(p.arguments) ?? p.arguments : p.type === "custom_tool_call" ? p.input : p.action;
            if (p.type === "local_shell_call" && raw && Array.isArray(raw.command)) raw = { command: raw.command };
            pendingCalls.push({ id, name, input: normalizeInput(name, raw), inputChars: typeof raw === "string" ? raw.length : textChars(raw), ts });
            yield { ...base(), kind: "meta", ts };
            break;
          }
          case "function_call_output":
          case "custom_tool_call_output": {
            const id = p.call_id;
            if (!id) break;
            // The call's usage arrives with the turn's next token_count; results are joined by call_id later.
            pendingIn += textChars(p.output);
            yield { ...base(), kind: "message", role: "user", ts, toolResults: [{ toolUseId: id, isError: outputIsError(p.output), chars: textChars(p.output) }] };
            break;
          }
          case "compaction":
          case "compaction_summary":
          case "context_compaction":
            yield { ...base(), kind: "compaction", ts };
            break;
          default:
            yield { ...base(), kind: "meta", ts };
        }
        break;
      }
      case "event_msg": {
        if (p.type === "token_count") {
          const total = usageOf(p.info?.total_token_usage);
          let usage = null;
          if (total) {
            usage = delta(total, prevTotal);
            prevTotal = total;
          } else {
            const last = usageOf(p.info?.last_token_usage);
            if (last) usage = { input: last.input, output: last.output, cacheRead: last.cacheRead, cacheWrite5m: last._write, cacheWrite1h: 0, thinking: last.thinking };
          }
          if (usage) sawUsage = true;
          if (usage || pendingCalls.length) yield flush(ts, usage, false);
          else yield { ...base(), kind: "meta", ts };
        } else if (p.type === "item_completed" && p.item && typeof p.item === "object") {
          // Newer CLIs mirror messages as items (item.type UserMessage / AgentMessage); only counted for the estimate fallback.
          if (/^agent_?message$/i.test(String(p.item.type))) pendingOut += textChars(p.item.content);
          yield { ...base(), kind: "meta", ts };
        } else if (p.type === "task_complete" || p.type === "turn_complete") {
          yield flushEstimated(ts) ?? { ...base(), kind: "meta", ts };
        } else yield { ...base(), kind: "meta", ts };
        break;
      }
      default:
        yield { ...base(), kind: "meta", ts };
    }
  }
  const tail = flushEstimated(null);
  if (tail) yield tail;
}
