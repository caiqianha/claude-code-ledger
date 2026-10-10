/**
 * Turn raw Claude Code JSONL records into a normalized model.
 *
 * Privacy: this module reads token counts, tool names, tool input *keys*
 * (file paths / command previews) and result sizes. It never keeps
 * message text, thinking, or tool output.
 */

const READ_LIKE = new Set(["Read", "Glob", "Grep", "Bash", "WebFetch", "WebSearch", "ToolSearch"]);

export function isReadLike(name) {
  return READ_LIKE.has(name) || name.startsWith("mcp__");
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

function stable(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]";
  return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + stable(v[k])).join(",") + "}";
}

/** A stable identity for "the same call again", plus a short display preview. */
export function describeInput(name, input) {
  if (!input || typeof input !== "object") return { key: name, preview: "" };
  const p = input.file_path || input.path || input.notebook_path || "";
  let key;
  switch (name) {
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

function session(model, rec) {
  const id = rec.sessionId || rec._fileSession;
  let s = model.sessions.get(id);
  if (!s) {
    s = {
      id,
      project: projectName(rec),
      projectDir: rec._projectDir,
      cwd: rec.cwd || null,
      file: rec._file || null,
      firstTs: null,
      lastTs: null,
      version: rec.version || null,
      gitBranch: rec.gitBranch || null,
      slug: rec.slug || null,
      humanTurns: 0,
      compactions: [], // timestamps of compact_boundary records
      seq: 0,
    };
    model.sessions.set(id, s);
  }
  if (rec.timestamp) {
    const t = Date.parse(rec.timestamp);
    if (!Number.isNaN(t)) {
      if (s.firstTs === null || t < s.firstTs) s.firstTs = t;
      if (s.lastTs === null || t > s.lastTs) s.lastTs = t;
    }
  }
  if (!s.cwd && rec.cwd) {
    s.cwd = rec.cwd;
    s.project = projectName(rec);
  }
  if (!s.gitBranch && rec.gitBranch) s.gitBranch = rec.gitBranch;
  if (!s.slug && rec.slug) s.slug = rec.slug;
  return s;
}

/** Consume an (async or sync) iterable of records into a model. Safe to call repeatedly (incremental). */
export async function buildModel(records, model = newModel()) {
  for await (const rec of records) {
    model.stats.lines++;
    const s = session(model, rec);
    const ts = rec.timestamp ? Date.parse(rec.timestamp) : NaN;
    const sidechain = rec.isSidechain === true;

    if (rec.type === "assistant" && rec.message) {
      const m = rec.message;
      const id = m.id || rec.uuid;
      if (!id || m.model === "<synthetic>") continue;
      let msg = model.messages.get(id);
      const u = usageFrom(m.usage);
      if (!msg) {
        msg = {
          id,
          sessionId: s.id,
          model: m.model || "unknown",
          ts: Number.isNaN(ts) ? null : ts,
          seq: s.seq++,
          sidechain,
          usage: u,
          toolUseIds: [],
          stopReason: m.stop_reason || null,
        };
        model.messages.set(id, msg);
      } else {
        // Streaming splits one API message across several lines that repeat the same usage.
        msg.usage = maxUsage(msg.usage, u);
        if (m.stop_reason) msg.stopReason = m.stop_reason;
      }
      const content = Array.isArray(m.content) ? m.content : [];
      for (const b of content) {
        if (!b || b.type !== "tool_use" || !b.id || model.toolUses.has(b.id)) continue;
        const { key, preview } = describeInput(b.name || "unknown", b.input);
        model.toolUses.set(b.id, {
          id: b.id,
          name: b.name || "unknown",
          key,
          preview,
          inputChars: b.input ? stable(b.input).length : 0,
          messageId: id,
          model: msg.model,
          sessionId: s.id,
          sidechain,
          ts: Number.isNaN(ts) ? null : ts,
        });
        msg.toolUseIds.push(b.id);
      }
      continue;
    }

    if (rec.type === "user" && rec.message) {
      const content = rec.message.content;
      if (isHumanTurn(content) && !rec.isMeta && !sidechain) s.humanTurns++;
      if (!Array.isArray(content)) continue;
      for (const b of content) {
        if (!b || b.type !== "tool_result" || !b.tool_use_id) continue;
        model.toolResults.set(b.tool_use_id, {
          toolUseId: b.tool_use_id,
          isError: b.is_error === true,
          chars: resultChars(b.content),
          ts: Number.isNaN(ts) ? null : ts,
        });
      }
      continue;
    }

    if (rec.type === "cost-state") {
      const prev = model.costStates.get(s.id);
      if (!prev || (rec.totalDuration || 0) >= (prev.totalDuration || 0)) model.costStates.set(s.id, rec);
      continue;
    }

    if (rec.type === "system" && rec.subtype === "compact_boundary") {
      s.compactions.push(Number.isNaN(ts) ? s.lastTs || 0 : ts);
    }
  }
  return model;
}
