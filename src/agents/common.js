/* Helpers shared by the non-Claude readers. No message text ever leaves these functions. */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

export const CHARS_PER_TOKEN = 4;

/** Rough token estimate from a character count (labelled "estimated" everywhere it is shown). */
export function estimateTokens(chars) {
  return Math.round((chars || 0) / CHARS_PER_TOKEN);
}

/** Character count of a string / part / part list (Gemini PartListUnion, Codex content arrays…). */
export function textChars(v) {
  if (v == null) return 0;
  if (typeof v === "string") return v.length;
  if (Array.isArray(v)) return v.reduce((n, x) => n + textChars(x), 0);
  if (typeof v === "object") {
    if (typeof v.text === "string") return v.text.length;
    if (v.inlineData || v.image_url || v.type === "input_image" || v.type === "image") return 6000;
    if (v.functionResponse) return safeLen(v.functionResponse.response);
    if (v.functionCall) return safeLen(v.functionCall.args);
    if (typeof v.output === "string") return v.output.length;
    if (typeof v.content === "string") return v.content.length;
    if (Array.isArray(v.content)) return textChars(v.content);
    return safeLen(v);
  }
  return String(v).length;
}

function safeLen(v) {
  try {
    return JSON.stringify(v)?.length || 0;
  } catch {
    return 0;
  }
}

const PATH_KEYS = ["file_path", "absolute_path", "path", "targetFile", "target_file", "relativeWorkspacePath", "relative_workspace_path", "filePath", "file", "filename", "notebook_path"];
const DIR_KEYS = ["dir_path", "directory", "dir", "target_directory", "relative_workspace_path"];
const CMD_KEYS = ["command", "cmd", "commandLine", "command_line", "script"];
const PATTERN_KEYS = ["pattern", "regex", "query_pattern", "glob", "glob_pattern", "include_pattern"];
const QUERY_KEYS = ["query", "search_term", "q"];

/**
 * Map another agent's tool input onto the Claude-style keys that `describeInput` understands
 * (file_path, path, command, pattern, query, url, offset, limit). Unknown keys are dropped: only
 * identifiers that would show up in a Claude `detail` column are kept, never free text.
 */
export function normalizeInput(name, input) {
  if (input == null) return undefined;
  if (typeof input === "string") {
    const parsed = tryJson(input);
    if (parsed && typeof parsed === "object") return normalizeInput(name, parsed);
    // apply_patch style bodies: pull the first file path out of the patch header
    const m = /\*\*\* (?:Update|Add|Delete) File: (.+)/.exec(input);
    return m ? { file_path: m[1].trim() } : { input_chars: input.length };
  }
  if (typeof input !== "object") return { value: input };
  const out = {};
  const str = (v) => (typeof v === "string" ? v : Array.isArray(v) ? v.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ") : v == null ? "" : String(v));
  for (const k of CMD_KEYS) if (input[k] != null && input[k] !== "") { out.command = str(input[k]); break; }
  for (const k of PATH_KEYS) if (typeof input[k] === "string" && input[k]) { out.file_path = input[k]; break; }
  if (!out.file_path) for (const k of DIR_KEYS) if (typeof input[k] === "string" && input[k]) { out.path = input[k]; break; }
  if (Array.isArray(input.paths) && input.paths.length) out.file_path = input.paths.map(String).join(" ");
  for (const k of PATTERN_KEYS) if (typeof input[k] === "string" && input[k]) { out.pattern = input[k]; break; }
  for (const k of QUERY_KEYS) if (typeof input[k] === "string" && input[k]) { out.query = input[k]; break; }
  if (typeof input.url === "string") out.url = input.url;
  if (typeof input.prompt === "string" && !out.url) { const u = /https?:\/\/\S+/.exec(input.prompt); if (u) out.url = u[0]; }
  if (typeof input.input === "string") { const m = /\*\*\* (?:Update|Add|Delete) File: (.+)/.exec(input.input); if (m) out.file_path = m[1].trim(); }
  const off = input.offset ?? input.start_line ?? input.startLine ?? input.start_line_one_indexed;
  const lim = input.limit ?? input.end_line ?? input.endLine ?? input.end_line_one_indexed_inclusive;
  if (typeof off === "number" && off) out.offset = off;
  if (typeof lim === "number" && lim) out.limit = lim;
  if (!Object.keys(out).length) {
    // Nothing recognizable: keep the key *names* only (stable identity, no content).
    out.keys = Object.keys(input).sort().join(",");
  }
  return out;
}

export function tryJson(s) {
  if (typeof s !== "string") return s;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export function parseTs(v) {
  if (v == null) return null;
  if (typeof v === "number") return v > 1e12 ? v : v > 1e9 ? v * 1000 : null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

/** Recursively list files under `dir` matching `pred`. Missing directories yield nothing. */
export function walkFiles(dir, pred, out = []) {
  let ents;
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of ents) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walkFiles(p, pred, out);
    else if (ent.isFile() && pred(p)) out.push(p);
  }
  return out;
}

/** Stream parsed JSONL objects from a file; malformed or non-object lines are skipped. */
export async function* iterJsonl(file) {
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec && typeof rec === "object") yield rec;
  }
}
