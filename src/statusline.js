import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listSessionFiles, readRecordsFrom } from "./loader.js";
import { buildModel, newModel } from "./parse.js";
import { analyze, totalTokens, cacheHitRate } from "./analyze.js";
import { fmtUsd, fmtNum, fmtPct, truncate, c } from "./render.js";
import { formatBudget } from "./budget.js";

const MAP_KEYS = ["messages", "toolUses", "toolResults", "sessions", "costStates"];
const CACHE_VERSION = 1;

function cacheDir() {
  return path.join(os.tmpdir(), "ccledger-statusline");
}

function cachePath(file) {
  return path.join(cacheDir(), path.basename(file, ".jsonl") + ".json");
}

function loadCache(file) {
  try {
    const j = JSON.parse(fs.readFileSync(cachePath(file), "utf8"));
    if (j.v !== CACHE_VERSION || j.file !== file) return null;
    const model = newModel();
    for (const k of MAP_KEYS) model[k] = new Map(j.model[k]);
    model.stats = j.model.stats || { lines: 0 };
    return { offset: j.offset, model };
  } catch {
    return null;
  }
}

function saveCache(file, offset, model) {
  try {
    fs.mkdirSync(cacheDir(), { recursive: true });
    const dump = { stats: model.stats };
    for (const k of MAP_KEYS) dump[k] = [...model[k]];
    const tmp = cachePath(file) + `.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ v: CACHE_VERSION, file, offset, model: dump }));
    fs.renameSync(tmp, cachePath(file)); // atomic: concurrent runs never see a half-written cache
  } catch {
    /* cache is best-effort */
  }
}

function latestFile(dirs, sid) {
  const all = dirs.flatMap((d) => (fs.existsSync(d) ? listSessionFiles(d) : []));
  const cand = sid ? all.filter((f) => path.basename(f.file).startsWith(sid)) : all;
  let best = null;
  for (const f of cand) {
    const m = fs.statSync(f.file).mtimeMs;
    if (!best || m > best.m) best = { file: f.file, m };
  }
  return best?.file || null;
}

async function readStdinJson(stdin) {
  if (!stdin || stdin.isTTY) return {};
  let raw = "";
  for await (const chunk of stdin) raw += chunk;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/** Build (or incrementally update) the model for one transcript file. */
export async function sessionModel(file, { cache = true } = {}) {
  const cached = cache ? loadCache(file) : null;
  const model = cached?.model || newModel();
  const { records, offset } = readRecordsFrom(file, cached?.offset || 0);
  if (records.length) await buildModel(records, model);
  if (cache && (records.length || !cached)) saveCache(file, offset, model);
  return model;
}

function startOfToday(now = Date.now()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Estimated spend since local midnight across every transcript touched today.
 * Each file goes through the same incremental per-file cache as the statusline, so repeated
 * calls only parse new lines. Returns { est, sessions, tokens, files }.
 */
export async function todaySpend({ dirs, pricing, cache = true, now = Date.now() }) {
  const since = startOfToday(now);
  const out = { est: 0, sessions: 0, tokens: 0, files: 0, since };
  const files = dirs.flatMap((d) => (fs.existsSync(d) ? listSessionFiles(d) : [])).filter((f) => {
    try {
      return fs.statSync(f.file).mtimeMs >= since;
    } catch {
      return false;
    }
  });
  for (const f of files) {
    try {
      const model = await sessionModel(f.file, { cache });
      const r = analyze(model, { pricing, since });
      if (!r.totals.messages) continue;
      out.files++;
      out.sessions += r.sessionsIncluded;
      out.est += r.totals.est;
      out.tokens += totalTokens(r.totals);
    } catch {
      /* skip unreadable file */
    }
  }
  return out;
}

function pctColor(p) {
  if (p == null) return (s) => s;
  if (p >= 90) return c.red;
  if (p >= 70) return c.yellow;
  return (s) => s;
}

/**
 * One-line status for Claude Code's `statusLine` setting.
 * Reads the statusLine JSON on stdin (model, cost, context_window, transcript_path),
 * tails the transcript incrementally and prints: model · cost · context · tools · cache · top flag.
 */
export async function statusline({ dirs, pricing, session, io, noCache = false, budget = null }) {
  const input = await readStdinJson(io.stdin);
  const file = input.transcript_path && fs.existsSync(input.transcript_path) ? input.transcript_path : latestFile(dirs, session || input.session_id);
  const cols = Number(process.env.COLUMNS) || 120;

  let ss = null;
  let flag = null;
  let sessionModelName = null;
  if (file) {
    try {
      const model = await sessionModel(file, { cache: !noCache });
      const r = analyze(model, { pricing });
      ss = r.bySession[0] || null;
      flag = r.waste[0] || null;
      sessionModelName = ss?.primaryModel || null;
    } catch {
      /* fall through to stdin-only output */
    }
  }

  const modelName = input.model?.display_name || sessionModelName;
  const reported = input.cost?.total_cost_usd ?? ss?.reported ?? null;
  const cost = reported != null ? fmtUsd(reported) : ss ? `${fmtUsd(ss.est, ss.unknownModel)} est` : null;

  const cw = input.context_window;
  const usage = cw?.current_usage;
  let ctxTokens = usage ? (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0) : null;
  let ctxPct = cw?.used_percentage ?? (ctxTokens != null && cw?.context_window_size ? (ctxTokens / cw.context_window_size) * 100 : null);
  const ctx = ctxTokens != null ? pctColor(ctxPct)(`ctx ${fmtNum(ctxTokens)}${ctxPct != null ? ` ${Math.round(ctxPct)}%` : ""}`) : null;

  const tools = ss ? `${ss.toolCalls} calls` + (ss.toolErrors ? c.red(` ${ss.toolErrors} err`) : "") : null;
  const cache = ss && ss.cacheRead ? `cache ${fmtPct(cacheHitRate(ss))}` : null;
  const tokens = ss ? `${fmtNum(totalTokens(ss))} tok` : null;
  let budgetSeg = null;
  if (budget) {
    const today = await todaySpend({ dirs, pricing, cache: !noCache });
    budgetSeg = formatBudget(today.est, budget);
  }
  const warn = flag ? (flag.severity === "high" ? c.red : c.yellow)(`⚠ ${flag.kind}${flag.tool && flag.tool !== "-" ? ` ${flag.tool}` : ""} ${truncate(flag.detail, 28)}${flag.count > 1 ? ` ×${flag.count}` : ""}`) : null;

  // Segments ordered by importance; trailing ones are dropped when the row is too narrow.
  const segs = [modelName && c.dim(modelName), cost && c.bold(cost), budgetSeg, ctx, tools, cache, tokens, warn].filter(Boolean);
  const visible = (s) => s.replace(/\x1b\[[0-9;]*m/g, "").length;
  while (segs.length > 2 && visible(segs.join(" · ")) > cols - 4) segs.pop();
  io.stdout.write((segs.length ? segs.join(" · ") : "ccledger: no session yet") + "\n");
}
