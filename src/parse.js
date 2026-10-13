/**
 * Normalized session model shared by every log reader.
 *
 * Readers (src/agents/*.js) turn an agent's native log format into a stream of
 * *turns* (see `ingestTurn` below for the shape); this module folds turns into the
 * in-memory model that analyze.js consumes. The Claude Code reader lives here too
 * (`buildModel`), because it is the reference implementation of the mapping.
 *
 * Privacy: this module reads token counts, tool names, tool input *keys*
 * (file paths / command previews) and result sizes. It never keeps
 * message text, thinking, or tool output.
 */

const READ_LIKE = new Set(["Read", "Glob", "Grep", "Bash", "WebFetch", "WebSearch", "ToolSearch"]);

/** Read-like tool names used by other agents (Codex, Gemini CLI, Cursor), see src/agents. */
const READ_LIKE_FOREIGN = new Set([
  // Codex
  "shell", "local_shell", "exec_command", "container.exec", "read_file", "list_dir", "grep_files", "web_search",
  // Gemini CLI
  "run_shell_command", "glob", "search_file_content", "grep_search", "list_directory", "read_many_files", "google_web_search", "web_fetch",
  // Cursor
  "read_file_v2", "ripgrep_raw_search", "glob_file_search", "codebase_search", "grep_search_v2", "run_terminal_command_v2", "run_terminal_cmd", "list_dir_v2", "read_lints", "web_search_v2", "fetch_rules",
]);

export function isReadLike(name) {
  return READ_LIKE.has(name) || READ_LIKE_FOREIGN.has(name) || name.startsWith("mcp__");
}

export function emptyUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, thinking: 0 };
}

function usageFrom(u) {
  if (!u) return emptyUsage();
  const cw = u.cache_creation || {};
  const total5m = cw.ephemeral_5m_input_tokens;
  const total1h = cw.ephemeral_1h_input_tokens;
  const cacheWrite = u.cache_creation_input_tokens || 0;
  // If no breakdown is present, attribute all cache writes to the 5m tier.
  const has = typeof total5m === "number" || typeof total1h === "number";
  return {
    input: u.input_tokens || 0,
    output: u.output_tokens || 0,
    cacheRead: u.cache_read_input_tokens || 0,
    cacheWrite5m: has ? total5m || 0 : cacheWrite,
    cacheWrite1h: has ? total1h || 0 : 0,
    thinking: u.output_tokens_details?.thinking_tokens || 0,
  };
}

function maxUsage(a, b) {
  const out = {};
  for (const k of Object.keys(a)) out[k] = Math.max(a[k] || 0, b[k] || 0);
  return out;
}

function projectName(rec) {
  if (rec.cwd) return rec.cwd.split(/[\\/]/).filter(Boolean).pop() || rec.cwd;
  return rec._projectDir || "unknown";
}

/** Last path segment of a directory, for display. */
export function baseName(p) {
  if (!p) return null;
  return String(p).split(/[\\/]/).filter(Boolean).pop() || String(p);
}

export function stable(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]";
  return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + stable(v[k])).join(",") + "}";
}

/**
 * Tool names of other agents mapped onto the Claude Code tool whose input shape they
 * resemble, so `describeInput` derives the same kind of key (path, command, pattern…).
 * Readers normalize their input objects to Claude-style keys (file_path, command, pattern, path, query, url).
 */
const CANON = {
  // Codex
  shell: "Bash", local_shell: "Bash", exec_command: "Bash", "container.exec": "Bash", apply_patch: "Edit", read_file: "Read", list_dir: "Glob", grep_files: "Grep", web_search: "WebSearch",
  // Gemini CLI
  run_shell_command: "Bash", glob: "Glob", search_file_content: "Grep", grep_search: "Grep", list_directory: "Glob", read_many_files: "Read", write_file: "Write", replace: "Edit", google_web_search: "WebSearch", web_fetch: "WebFetch",
  // Cursor
  read_file_v2: "Read", ripgrep_raw_search: "Grep", grep_search_v2: "Grep", glob_file_search: "Glob", list_dir_v2: "Glob", run_terminal_command_v2: "Bash", run_terminal_cmd: "Bash", edit_file_v2: "Edit", edit_file: "Edit", write_file_v2: "Write", delete_file: "Write", codebase_search: "Grep", web_search_v2: "WebSearch", read_lints: "Read",
};

/** A stable identity for "the same call again", plus a short display preview. */
export function describeInput(name, input) {
  if (!input || typeof input !== "object") return { key: name, preview: "" };
  const p = input.file_path || input.path || input.notebook_path || "";
  let key;
  switch (CANON[name] || name) {
    case "Read":
      key = `${p}${input.offset ? ` @${input.offset}` : ""}${input.limit ? ` +${input.limit}` : ""}`;
      break;
    case "Edit":
    case "Write":
    case "MultiEdit":
    case "NotebookEdit":
      key = p;
      break;
    case "Glob":
    case "Grep":
      key = `${input.pattern ?? ""} ${p}`.trim();
      break;
    case "Bash":
      key = String(input.command || "").trim().replace(/\s+/g, " ");
      break;
    case "WebFetch":
      key = String(input.url || "");
      break;
    case "WebSearch":
      key = String(input.query || "");
      break;
    case "Agent":
    case "Task":
      key = String(input.description || input.subagent_type || "").trim();
      break;
    default:
      if (name.startsWith("mcp__")) {
        // Friendlier than raw JSON: the string-valued fields, in a stable order.
        // Flatten one level so {path:{document_id:"x"}} reads as document_id=x.
        const flat = {};
        for (const [k, v] of Object.entries(input)) {
          if (v && typeof v === "object" && !Array.isArray(v)) for (const [k2, v2] of Object.entries(v)) flat[k2] = v2;
          else flat[k] = v;
        }
        const parts = Object.keys(flat)
          .sort()
          .filter((k) => (typeof flat[k] === "string" && flat[k].length) || typeof flat[k] === "number")
          .map((k) => `${k}=${flat[k]}`);
        key = parts.length ? parts.join(" ") : stable(input);
      } else {
        key = stable(input);
      }
      key = key.slice(0, 300);
  }
  const preview = key.length > 80 ? key.slice(0, 77) + "..." : key;
  return { key: `${name} ${key}`, preview };
}

function resultChars(content) {
  if (content == null) return 0;
  if (typeof content === "string") return content.length;
  if (Array.isArray(content)) {
    let n = 0;
    for (const b of content) {
      if (!b) continue;
      if (typeof b === "string") n += b.length;
      else if (typeof b.text === "string") n += b.text.length;
      else if (b.type === "image") n += 6000; // ~1.5k tokens, expressed in chars
    }
    return n;
  }
  return 0;
}

function isHumanTurn(content) {
  if (typeof content === "string") return true;
  if (!Array.isArray(content)) return false;
  return content.some((b) => b && b.type === "text");
}

export function newModel() {
  return {
    messages: new Map(), // message.id -> message
    toolUses: new Map(), // tool_use.id -> call
    toolResults: new Map(), // tool_use.id -> result
    sessions: new Map(), // sessionId -> session
    costStates: new Map(), // sessionId -> last cost-state record
    stats: { lines: 0 },
  };
}

/* ------------------------------------------------------------------ */
/* Normalized turns                                                     */
/* ------------------------------------------------------------------ */

/**
 * Fold one normalized turn into the model. Every reader yields turns of this shape:
 *
 *   {
 *     agent: "claude" | "codex" | "gemini" | "cursor",
 *     sessionId, ts: ms | null,
 *     // session metadata, used on first sight (any turn may carry it):
 *     cwd?, project?, projectDir?, file?, version?, gitBranch?, slug?,
 *     kind: "message" | "cost" | "compaction" | "meta",
 *     // kind "message":
 *     role: "user" | "assistant",
 *     id?: stable message id (streaming chunks repeat it; usage is max-merged),
 *     model?, usage?: {input, output, cacheRead, cacheWrite5m, cacheWrite1h, thinking},
 *     estimated?: true when usage was derived from text length (chars/4) rather than recorded,
 *     stopReason?, sidechain?, humanTurn? (user text written by a person),
 *     toolCalls?: [{ id, name, input }],            // assistant
 *     toolResults?: [{ toolUseId, isError, chars }], // user
 *     // kind "cost": cost = Claude Code cost-state record
 *   }
 *
 * Turns are processed in file order; a turn whose kind is "meta" only touches session metadata.
 */
export function ingestTurn(model, t) {
  model.stats.lines++;
  const s = session(model, t);
  const ts = t.ts ?? null;
  const sidechain = t.sidechain === true;

  if (t.kind === "message" && t.role === "assistant") {
    const id = t.id;
    if (!id) return;
    let msg = model.messages.get(id);
    const u = t.usage || emptyUsage();
    if (!msg) {
      msg = {
        id,
        sessionId: s.id,
        model: t.model || "unknown",
        ts,
        seq: s.seq++,
        sidechain,
        usage: u,
        toolUseIds: [],
        stopReason: t.stopReason || null,
      };
      if (t.estimated) {
        msg.estimated = true;
        s.estimated = true;
      }
      model.messages.set(id, msg);
    } else {
      // Streaming splits one API message across several lines that repeat the same usage.
      msg.usage = maxUsage(msg.usage, u);
      if (t.stopReason) msg.stopReason = t.stopReason;
    }
    for (const b of t.toolCalls || []) {
      if (!b || !b.id || model.toolUses.has(b.id)) continue;
      const { key, preview } = describeInput(b.name || "unknown", b.input);
      model.toolUses.set(b.id, {
        id: b.id,
        name: b.name || "unknown",
        key,
        preview,
        inputChars: b.inputChars ?? (b.input ? stable(b.input).length : 0),
        messageId: id,
        model: msg.model,
        sessionId: s.id,
        sidechain,
        ts: b.ts ?? ts,
      });
      msg.toolUseIds.push(b.id);
    }
    return;
  }

  if (t.kind === "message" && t.role === "user") {
    if (t.humanTurn && !sidechain) s.humanTurns++;
    for (const b of t.toolResults || []) {
      if (!b || !b.toolUseId) continue;
      model.toolResults.set(b.toolUseId, {
        toolUseId: b.toolUseId,
        isError: b.isError === true,
        chars: b.chars || 0,
        ts: b.ts ?? ts,
      });
    }
    return;
  }

  if (t.kind === "cost") {
    const rec = t.cost;
    const prev = model.costStates.get(s.id);
    if (!prev || (rec.totalDuration || 0) >= (prev.totalDuration || 0)) model.costStates.set(s.id, rec);
    return;
  }

  if (t.kind === "compaction") {
    s.compactions.push(ts === null ? s.lastTs || 0 : ts);
  }
}

function session(model, t) {
  const id = t.sessionId;
  let s = model.sessions.get(id);
  if (!s) {
    s = {
      id,
      project: t.project || t.projectDir || "unknown",
      projectDir: t.projectDir,
      cwd: t.cwd || null,
      file: t.file || null,
      firstTs: null,
      lastTs: null,
      version: t.version || null,
      gitBranch: t.gitBranch || null,
      slug: t.slug || null,
      humanTurns: 0,
      compactions: [], // timestamps of compact_boundary records
      seq: 0,
    };
    if (t.agent && t.agent !== "claude") s.agent = t.agent;
    if (t.noPricing) s.noPricing = true; // agent without per-token billing (Cursor)
    model.sessions.set(id, s);
  }
  if (t.ts != null) {
    if (s.firstTs === null || t.ts < s.firstTs) s.firstTs = t.ts;
    if (s.lastTs === null || t.ts > s.lastTs) s.lastTs = t.ts;
  }
  if (!s.cwd && t.cwd) {
    s.cwd = t.cwd;
    s.project = t.project || baseName(t.cwd);
  }
  if (!s.gitBranch && t.gitBranch) s.gitBranch = t.gitBranch;
  if (!s.slug && t.slug) s.slug = t.slug;
  return s;
}

/** Consume an (async or sync) iterable of normalized turns into a model. */
export async function ingestTurns(turns, model = newModel()) {
  for await (const t of turns) ingestTurn(model, t);
  return model;
}

/* ------------------------------------------------------------------ */
/* Claude Code reader                                                    */
/* ------------------------------------------------------------------ */

/** Map one raw Claude Code JSONL record onto a normalized turn. */
export function claudeTurn(rec) {
  const ts = rec.timestamp ? Date.parse(rec.timestamp) : NaN;
  const t = {
    agent: "claude",
    sessionId: rec.sessionId || rec._fileSession,
    ts: Number.isNaN(ts) ? null : ts,
    cwd: rec.cwd || null,
    project: rec.cwd ? projectName(rec) : null,
    projectDir: rec._projectDir,
    file: rec._file || null,
    version: rec.version || null,
    gitBranch: rec.gitBranch || null,
    slug: rec.slug || null,
    sidechain: rec.isSidechain === true,
    kind: "meta",
  };
  if (!t.project) t.project = rec._projectDir || "unknown";

  if (rec.type === "assistant" && rec.message) {
    const m = rec.message;
    const id = m.id || rec.uuid;
    if (!id || m.model === "<synthetic>") return t;
    t.kind = "message";
    t.role = "assistant";
    t.id = id;
    t.model = m.model || "unknown";
    t.usage = usageFrom(m.usage);
    t.stopReason = m.stop_reason || null;
    const content = Array.isArray(m.content) ? m.content : [];
    t.toolCalls = [];
    for (const b of content) {
      if (!b || b.type !== "tool_use" || !b.id) continue;
      t.toolCalls.push({ id: b.id, name: b.name || "unknown", input: b.input });
    }
    return t;
  }
  if (rec.type === "user" && rec.message) {
    const content = rec.message.content;
    t.kind = "message";
    t.role = "user";
    t.humanTurn = isHumanTurn(content) && !rec.isMeta;
    t.toolResults = [];
    if (Array.isArray(content)) {
      for (const b of content) {
        if (!b || b.type !== "tool_result" || !b.tool_use_id) continue;
        t.toolResults.push({ toolUseId: b.tool_use_id, isError: b.is_error === true, chars: resultChars(b.content) });
      }
    }
    return t;
  }
  if (rec.type === "cost-state") {
    t.kind = "cost";
    t.cost = rec;
    return t;
  }
  if (rec.type === "system" && rec.subtype === "compact_boundary") t.kind = "compaction";
  return t;
}

/** Consume an (async or sync) iterable of raw Claude Code records into a model. Safe to call repeatedly (incremental). */
export async function buildModel(records, model = newModel()) {
  for await (const rec of records) ingestTurn(model, claudeTurn(rec));
  return model;
}
