/**
 * Cursor (best effort). Cursor keeps chat state in SQLite:
 *   macOS   ~/Library/Application Support/Cursor/User/globalStorage/state.vscdb
 *   Linux   ~/.config/Cursor/User/globalStorage/state.vscdb
 *   Windows %APPDATA%/Cursor/User/globalStorage/state.vscdb
 * plus one state.vscdb per workspace under User/workspaceStorage/<hash>/.
 *
 * Read with the `sqlite3` CLI (zero npm deps); when it is missing the reader reports that and skips.
 * Only projected columns are pulled out with json_extract(): message type, timestamp, text *length*,
 * tokenCount, tool name/status/params/result *length*, model name. Message text is never selected.
 *
 * Tables / keys used (Cursor 1.x "composer" format, observed 2026-10):
 *   cursorDiskKV  composerData:<composerId>  {composerId, createdAt, lastUpdatedAt, modelConfig.modelName,
 *                                             workspaceIdentifier.uri.fsPath?, fullConversationHeadersOnly[]}
 *   cursorDiskKV  bubbleId:<composerId>:<bubbleId>  {type: 1 user | 2 assistant, createdAt, text,
 *                                             tokenCount{inputTokens,outputTokens}, toolFormerData{name,status,params,result}, modelInfo.modelName}
 *   ItemTable     workbench.panel.aichat.view.aichat.chatdata  (legacy pre-composer chat tabs; unverified)
 *
 * Not available: cost (Cursor bills per request / subscription, not per token), cache tokens, compaction
 * events. Token counts are sparse, so most usage is estimated from text length (chars/4) and flagged.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { normalizeInput, parseTs, estimateTokens } from "./common.js";
import { baseName } from "../parse.js";

export function cursorUserDir() {
  if (process.env.CURSOR_USER_DIR) return process.env.CURSOR_USER_DIR;
  const home = os.homedir();
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", "Cursor", "User");
  if (process.platform === "win32") return path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "Cursor", "User");
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "Cursor", "User");
}

let sqliteOk = null;
export function hasSqlite3() {
  if (sqliteOk !== null) return sqliteOk;
  try {
    execFileSync("sqlite3", ["-version"], { stdio: ["ignore", "pipe", "ignore"] });
    sqliteOk = true;
  } catch {
    sqliteOk = false;
  }
  return sqliteOk;
}

export function query(db, sql) {
  const out = execFileSync("sqlite3", ["-readonly", "-json", db, sql], { encoding: "utf8", maxBuffer: 1 << 30, stdio: ["ignore", "pipe", "ignore"] });
  return out.trim() ? JSON.parse(out) : [];
}

function safeQuery(db, sql) {
  try {
    return query(db, sql);
  } catch {
    return [];
  }
}

const V = "CAST(value AS TEXT)";
const jx = (p) => `json_extract(${V},'$.${p}')`;

export const cursor = {
  name: "cursor",
  label: "Cursor",
  location: "~/Library/Application Support/Cursor/User/globalStorage/state.vscdb (+ workspaceStorage/*/state.vscdb)",
  defaultDirs: () => [cursorUserDir()],
  /** "Files" are the SQLite databases: the global one plus every workspace one that exists. */
  listFiles(dirs) {
    const out = [];
    for (const d of dirs) {
      const g = d.endsWith(".vscdb") ? d : path.join(d, "globalStorage", "state.vscdb");
      if (fs.existsSync(g)) out.push({ file: g, projectDir: null, scope: "global" });
      const ws = path.join(d, "workspaceStorage");
      if (fs.existsSync(ws)) {
        for (const ent of fs.readdirSync(ws, { withFileTypes: true })) {
          if (!ent.isDirectory()) continue;
          const f = path.join(ws, ent.name, "state.vscdb");
          if (fs.existsSync(f)) out.push({ file: f, projectDir: ent.name, scope: "workspace" });
        }
      }
    }
    return out;
  },
  unavailable: () => (hasSqlite3() ? null : "sqlite3 CLI not found; install it (brew install sqlite / apt install sqlite3) to read Cursor chats"),
  async *read(entries) {
    if (!hasSqlite3()) return;
    const wsFolders = new Map(); // composerId -> folder path (from workspace dbs)
    const wsEntries = entries.filter((e) => e.scope === "workspace");
    for (const e of wsEntries) {
      const folder = workspaceFolder(path.dirname(e.file));
      for (const r of safeQuery(e.file, `select json_extract(CAST(value AS TEXT),'$.allComposers') as all_ from ItemTable where key='composer.composerData'`)) {
        for (const c of parseArr(r.all_)) if (c?.composerId && folder) wsFolders.set(c.composerId, folder);
      }
      yield* readLegacyChatData(e.file, folder);
    }
    for (const e of entries.filter((x) => x.scope === "global")) yield* readComposers(e.file, wsFolders);
  },
};

function parseArr(v) {
  if (Array.isArray(v)) return v;
  try {
    const j = JSON.parse(v);
    return Array.isArray(j) ? j : [];
  } catch {
    return [];
  }
}

function workspaceFolder(dir) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, "workspace.json"), "utf8"));
    const u = j.folder || j.workspace || null;
    return u ? decodeURIComponent(String(u).replace(/^file:\/\//, "")) : null;
  } catch {
    return null;
  }
}

export async function* readComposers(db, wsFolders = new Map()) {
  const composers = safeQuery(db, `select key, ${jx("createdAt")} as createdAt, ${jx("lastUpdatedAt")} as updatedAt, ${jx("modelConfig.modelName")} as model, ${jx("workspaceIdentifier.uri.fsPath")} as fsPath, ${jx("totalLinesAdded")} as la, ${jx("totalLinesRemoved")} as lr from cursorDiskKV where key like 'composerData:%' and json_valid(${V})`);
  if (!composers.length) return;
  const bubbles = safeQuery(db, `select key, ${jx("type")} as type, ${jx("createdAt")} as createdAt, length(${jx("text")}) as textLen, length(${jx("thinking.text")}) as thinkLen, ${jx("tokenCount.inputTokens")} as tin, ${jx("tokenCount.outputTokens")} as tout, ${jx("toolFormerData.name")} as tool, ${jx("toolFormerData.status")} as status, ${jx("toolFormerData.params")} as params, length(${jx("toolFormerData.result")}) as resultLen, ${jx("modelInfo.modelName")} as model from cursorDiskKV where key like 'bubbleId:%' and json_valid(${V})`);
  const byComposer = new Map();
  for (const b of bubbles) {
    const parts = String(b.key).split(":");
    if (parts.length < 3) continue;
    const cid = parts[1];
    (byComposer.get(cid) || byComposer.set(cid, []).get(cid)).push({ ...b, bubbleId: parts.slice(2).join(":") });
  }
  for (const c of composers) {
    const cid = String(c.key).slice("composerData:".length);
    const list = (byComposer.get(cid) || []).sort((a, b) => (parseTs(a.createdAt) || 0) - (parseTs(b.createdAt) || 0));
    if (!list.length) continue;
    const folder = c.fsPath || wsFolders.get(cid) || null;
    const base = { agent: "cursor", sessionId: cid, cwd: folder, project: folder ? baseName(folder) : "cursor", projectDir: null, file: db, noPricing: true };
    const created = parseTs(c.createdAt);
    if (created !== null) yield { ...base, kind: "meta", ts: created };
    let ctxChars = 0;
    let pendingUsage = null;
    let n = 0;
    for (const b of list) {
      const ts = parseTs(b.createdAt) ?? created;
      const tin = Number(b.tin) || 0;
      const tout = Number(b.tout) || 0;
      if (Number(b.type) === 1) {
        ctxChars += Number(b.textLen) || 0;
        if (tin || tout) pendingUsage = { input: tin, output: tout };
        yield { ...base, kind: "message", role: "user", ts, humanTurn: (Number(b.textLen) || 0) > 0 };
        continue;
      }
      if (Number(b.type) !== 2) continue;
      n++;
      const outChars = (Number(b.textLen) || 0) + (Number(b.thinkLen) || 0) + (b.params ? String(b.params).length : 0);
      let usage;
      let estimated = false;
      if (tin || tout) usage = { input: tin, output: tout, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, thinking: 0 };
      else if (pendingUsage) {
        usage = { ...pendingUsage, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, thinking: 0 };
        pendingUsage = null;
      } else {
        estimated = true;
        usage = { input: estimateTokens(ctxChars), output: estimateTokens(outChars), cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, thinking: 0 };
      }
      ctxChars += outChars;
      const turn = { ...base, kind: "message", role: "assistant", id: `${cid}:${b.bubbleId}`, ts, model: b.model || c.model || "cursor-unknown", usage, toolCalls: [] };
      if (estimated) turn.estimated = true;
      if (b.tool) {
        let raw = b.params;
        try {
          raw = JSON.parse(b.params);
        } catch {
          /* keep string */
        }
        turn.toolCalls.push({ id: `${cid}:${b.bubbleId}`, name: String(b.tool), input: normalizeInput(b.tool, raw), inputChars: b.params ? String(b.params).length : 0, ts });
      }
      yield turn;
      if (b.tool) {
        const rc = Number(b.resultLen) || 0;
        ctxChars += rc;
        const st = String(b.status || "").toLowerCase();
        yield { ...base, kind: "message", role: "user", ts, toolResults: [{ toolUseId: `${cid}:${b.bubbleId}`, isError: st === "error" || st === "failed" || st === "errored", chars: rc, ts }] };
      }
    }
    if (c.la != null || c.lr != null) yield { ...base, kind: "meta", ts: parseTs(c.updatedAt) ?? created };
  }
}

/** Legacy chat panel data (pre-composer Cursor). Shape from community documentation; unverified here. */
export async function* readLegacyChatData(db, folder) {
  const rows = safeQuery(db, `select ${V} as v from ItemTable where key='workbench.panel.aichat.view.aichat.chatdata'`);
  for (const r of rows) {
    let data;
    try {
      data = JSON.parse(r.v);
    } catch {
      continue;
    }
    for (const tab of data?.tabs || []) {
      const sid = tab.tabId || tab.id;
      if (!sid || !Array.isArray(tab.bubbles) || !tab.bubbles.length) continue;
      const base = { agent: "cursor", sessionId: `legacy:${sid}`, cwd: folder, project: folder ? baseName(folder) : "cursor", projectDir: null, file: db, noPricing: true };
      const t0 = parseTs(tab.lastSendTime) ?? null;
      let ctxChars = 0;
      let n = 0;
      for (const b of tab.bubbles) {
        const chars = typeof b.text === "string" ? b.text.length : typeof b.rawText === "string" ? b.rawText.length : 0;
        const ts = parseTs(b.createdAt ?? b.timestamp) ?? t0;
        if (b.type === "user") {
          ctxChars += chars;
          yield { ...base, kind: "message", role: "user", ts, humanTurn: chars > 0 };
        } else {
          n++;
          yield { ...base, kind: "message", role: "assistant", id: `legacy:${sid}:${n}`, ts, model: b.modelType || "cursor-unknown", usage: { input: estimateTokens(ctxChars), output: estimateTokens(chars), cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, thinking: 0 }, estimated: true, toolCalls: [] };
          ctxChars += chars;
        }
      }
    }
  }
}
