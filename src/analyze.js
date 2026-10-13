import { costOf, resolvePrice } from "./pricing.js";
import { isReadLike } from "./parse.js";

export function newStat() {
  return {
    messages: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    thinking: 0,
    est: 0,
    sub: 0, // est spent by subagents (sidechain messages)
    unknownModel: false,
    toolCalls: 0,
    toolErrors: 0,
    resultChars: 0,
    ctxCost: 0, // attributed context cost of tool results (see attribute())
    reported: null,
  };
}

function addUsage(st, u, cost, sidechain, flags = NOFLAGS) {
  st.messages++;
  st.input += u.input;
  st.output += u.output;
  st.cacheRead += u.cacheRead;
  st.cacheWrite += u.cacheWrite5m + u.cacheWrite1h;
  st.thinking += u.thinking;
  if (flags.estimated) st.estimated = true; // some tokens were estimated from text length
  if (flags.noPricing) {
    // Agents without per-token billing (Cursor): tokens only. Flag the row as unpriced
    // unless something priced also contributed; never mark it as an unknown model.
    if (!st._priced) st.noPricing = true;
    return;
  }
  if (!st._priced) Object.defineProperty(st, "_priced", { value: true, enumerable: false, writable: true, configurable: true });
  if (st.noPricing) delete st.noPricing;
  if (cost === null) st.unknownModel = true;
  else {
    st.est += cost;
    if (sidechain) st.sub += cost;
  }
}
const NOFLAGS = {};

export function totalTokens(st) {
  return st.input + st.output + st.cacheRead + st.cacheWrite;
}

export function cacheHitRate(st) {
  const denom = st.input + st.cacheRead + st.cacheWrite;
  return denom ? st.cacheRead / denom : 0;
}

export function localDay(ts) {
  return new Date(ts).toLocaleDateString("sv-SE"); // YYYY-MM-DD in local time
}

function bump(map, key, init) {
  let v = map.get(key);
  if (!v) {
    v = init();
    map.set(key, v);
  }
  return v;
}

/** Number of elements in a sorted numeric array strictly greater than x. */
function countAfter(sorted, x) {
  let lo = 0,
    hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] <= x) lo = mid + 1;
    else hi = mid;
  }
  return sorted.length - lo;
}

/** Index of the compaction epoch a timestamp falls in (0 = before any compaction). */
export function epochOf(compactions, ts) {
  let n = 0;
  for (const c of compactions) if (c <= ts) n++;
  return n;
}

/**
 * Aggregate a parsed model.
 * opts: { pricing, since?, until?, project?, largeOutput?, repeatMin?, charsPerToken? }
 */
export function analyze(model, opts) {
  const { pricing } = opts;
  const since = opts.since ?? -Infinity;
  const until = opts.until ?? Infinity;
  const projFilter = opts.project ? opts.project.toLowerCase() : null;
  const largeOutput = opts.largeOutput ?? 30_000;
  const repeatMin = opts.repeatMin ?? 4;
  const cpt = opts.charsPerToken ?? 4;

  const sessionOk = (s) =>
    !projFilter ||
    s.project.toLowerCase().includes(projFilter) ||
    (s.cwd || "").toLowerCase().includes(projFilter) ||
    (s.projectDir || "").toLowerCase().includes(projFilter);
  const tsOk = (ts) => ts === null || (ts >= since && ts <= until);

  const totals = newStat();
  const byDay = new Map();
  const byProject = new Map();
  const byModel = new Map();
  const bySession = new Map();
  const byTool = new Map();
  const byAgent = new Map();
  const sessionDayEst = new Map(); // sid -> Map(day -> est), for apportioning reported cost
  const sessionMsgTs = new Map(); // sid -> sorted message timestamps (all, unfiltered) for attribution
  const sessionModelEst = new Map(); // sid -> Map(model -> est), to find each session's primary model

  for (const msg of model.messages.values()) {
    if (msg.ts !== null) bump(sessionMsgTs, msg.sessionId, () => []).push(msg.ts);
  }
  for (const arr of sessionMsgTs.values()) arr.sort((a, b) => a - b);

  // ---- messages / tokens ----
  for (const msg of model.messages.values()) {
    const s = model.sessions.get(msg.sessionId);
    if (!s || !sessionOk(s) || !tsOk(msg.ts)) continue;
    const flags = s.noPricing || msg.estimated ? { noPricing: !!s.noPricing, estimated: !!msg.estimated } : NOFLAGS;
    const cost = s.noPricing ? null : costOf(msg.usage, resolvePrice(pricing, msg.model));
    addUsage(totals, msg.usage, cost, msg.sidechain, flags);
    if (msg.ts !== null) {
      const day = localDay(msg.ts);
      addUsage(bump(byDay, day, newStat), msg.usage, cost, msg.sidechain, flags);
      const sd = bump(sessionDayEst, s.id, () => new Map());
      sd.set(day, (sd.get(day) || 0) + (cost || 0));
    }
    addUsage(bump(byProject, s.project, newStat), msg.usage, cost, msg.sidechain, flags);
    addUsage(bump(byModel, msg.model, newStat), msg.usage, cost, msg.sidechain, flags);
    addUsage(bump(bySession, s.id, () => ({ ...newStat(), session: s })), msg.usage, cost, msg.sidechain, flags);
    addUsage(bump(byAgent, s.agent || "claude", newStat), msg.usage, cost, msg.sidechain, flags);
    const sm = bump(sessionModelEst, s.id, () => new Map());
    sm.set(msg.model, (sm.get(msg.model) || 0) + (cost || 0));
  }
  for (const [sid, sm] of sessionModelEst) {
    const ss = bySession.get(sid);
    const total = [...sm.values()].reduce((a, b) => a + b, 0);
    const [top, topEst] = [...sm.entries()].sort((a, b) => b[1] - a[1])[0];
    ss.primaryModel = total && topEst / total >= 0.9 ? top : null;
  }

  // ---- tool calls, with context-cost attribution ----
  const calls = [];
  for (const call of model.toolUses.values()) {
    const s = model.sessions.get(call.sessionId);
    if (!s || !sessionOk(s) || !tsOk(call.ts)) continue;
    const res = model.toolResults.get(call.id) || null;
    const rec = { ...call, result: res, project: s.project, epoch: call.ts !== null ? epochOf(s.compactions, call.ts) : 0, ctxCost: 0, alive: 0, ms: null };
    if (res) {
      if (res.ts !== null && call.ts !== null) rec.ms = Math.max(0, res.ts - call.ts);
      attribute(rec, s, sessionMsgTs.get(s.id) || [], pricing, cpt);
    }
    calls.push(rec);

    const t = bump(byTool, call.name, () => ({ name: call.name, calls: 0, errors: 0, resultChars: 0, maxResultChars: 0, inputChars: 0, ctxCost: 0, msTotal: 0, msCount: 0 }));
    t.calls++;
    t.inputChars += call.inputChars;
    if (res) {
      if (res.isError) t.errors++;
      t.resultChars += res.chars;
      if (res.chars > t.maxResultChars) t.maxResultChars = res.chars;
      t.ctxCost += rec.ctxCost;
      if (rec.ms !== null) {
        t.msTotal += rec.ms;
        t.msCount++;
      }
    }
    const bumpStat = (st) => {
      st.toolCalls++;
      if (res?.isError) st.toolErrors++;
      if (res) {
        st.resultChars += res.chars;
        st.ctxCost += rec.ctxCost;
      }
    };
    bumpStat(totals);
    if (call.ts !== null) bumpStat(bump(byDay, localDay(call.ts), newStat));
    bumpStat(bump(byProject, s.project, newStat));
    bumpStat(bump(bySession, s.id, () => ({ ...newStat(), session: s })));
    bumpStat(bump(byAgent, s.agent || "claude", newStat));
  }

  // ---- reported cost (Claude Code cost-state, cumulative per session), apportioned to days by est share ----
  let reported = 0;
  let reportedSessions = 0;
  for (const [sid, ss] of bySession) {
    const cs = model.costStates.get(sid);
    if (!cs || typeof cs.totalCostUSD !== "number") continue;
    ss.reported = cs.totalCostUSD;
    ss.linesAdded = cs.totalLinesAdded || 0;
    ss.linesRemoved = cs.totalLinesRemoved || 0;
    ss.apiMs = cs.totalAPIDuration || 0;
    ss.toolMs = cs.totalToolDuration || 0;
    reported += cs.totalCostUSD;
    reportedSessions++;
    const sd = sessionDayEst.get(sid);
    if (sd) {
      const total = [...sd.values()].reduce((a, b) => a + b, 0);
      for (const [day, est] of sd) {
        const d = byDay.get(day);
        if (!d) continue;
        d.reported = (d.reported || 0) + (total ? (cs.totalCostUSD * est) / total : cs.totalCostUSD / sd.size);
      }
    }
  }

  // ---- context cost by key (file / command / query) ----
  const byContext = new Map();
  for (const c of calls) {
    if (!c.result) continue;
    const k = bump(byContext, c.key, () => ({ key: c.key, tool: c.name, preview: c.preview, calls: 0, chars: 0, ctxCost: 0, sessions: new Set() }));
    k.calls++;
    k.chars += c.result.chars;
    k.ctxCost += c.ctxCost;
    k.sessions.add(c.sessionId);
  }

  const waste = detectWaste(calls, bySession, { largeOutput, repeatMin });

  const report = {
    range: { since: opts.since ?? null, until: opts.until ?? null, project: opts.project ?? null },
    totals,
    reported: { usd: reported, sessions: reportedSessions, of: bySession.size },
    byDay: sortMap(byDay),
    byProject: sortBy(byProject, (v) => -v.est),
    byModel: sortBy(byModel, (v) => -v.est),
    bySession: sortBy(bySession, (v) => -(v.reported ?? v.est)),
    byTool: sortBy(byTool, (v) => -v.calls),
    byContext: [...byContext.values()].map((k) => ({ ...k, sessions: k.sessions.size })).sort((a, b) => b.ctxCost - a.ctxCost),
    waste,
    sessionsIncluded: bySession.size,
    calibration: calibrate(model, bySession),
    byAgent: sortBy(byAgent, (v) => -v.est),
  };
  // Pattern counters feed `advise --claude-md` and `compare`. Kept off the JSON export (non-enumerable)
  // so existing exports stay unchanged; merge.js ignores them.
  Object.defineProperty(report, "patterns", { value: patternStats(calls, waste, bySession), enumerable: false });
  return report;
}

/* ------------------------------------------------------------------ */
/* Pattern counters (rates behind the CLAUDE.md suggestions)            */
/* ------------------------------------------------------------------ */

const FILE_READ = new Set(["Read", "read_file", "read_file_v2", "read_many_files", "read_lints"]);
const SEARCH = new Set(["Glob", "Grep", "glob", "search_file_content", "grep_search", "grep_search_v2", "ripgrep_raw_search", "glob_file_search", "codebase_search", "list_dir", "list_directory", "list_dir_v2", "grep_files"]);

export function patternStats(calls, waste, bySession) {
  const seen = new Set();
  const p = { toolCalls: calls.length, reads: 0, rereads: 0, searches: 0, researches: 0, shell: 0, reshell: 0, retries: 0, largeOutputs: 0, largeChars: 0, largeUsd: 0, largeByTool: {}, errors: 0, coldSessions: 0, sessions: bySession.size, wastedCalls: 0, wastedUsd: 0, rereadUsd: 0 };
  const sorted = calls.slice().sort((a, b) => (a.ts || 0) - (b.ts || 0));
  for (const c of sorted) {
    if (c.result?.isError) p.errors++;
    if (!isReadLike(c.name)) continue;
    const k = `${c.sessionId}\u0000${c.epoch}\u0000${c.key}`;
    const again = seen.has(k);
    seen.add(k);
    const isFile = FILE_READ.has(c.name);
    const isSearch = SEARCH.has(c.name);
    const isShell = !isFile && !isSearch && !c.name.startsWith("mcp__") && !/^Web/.test(c.name);
    if (isFile) { p.reads++; if (again) { p.rereads++; p.rereadUsd += c.ctxCost; } }
    else if (isSearch) { p.searches++; if (again) p.researches++; }
    else if (isShell) { p.shell++; if (again) p.reshell++; }
    if (again) { p.wastedCalls++; p.wastedUsd += c.ctxCost; }
  }
  for (const f of waste) {
    if (f.kind === "retry") { p.retries += f.count; p.wastedCalls += f.count; p.wastedUsd += f.usd || 0; }
    else if (f.kind === "large-output") { p.largeOutputs++; p.largeChars = Math.max(p.largeChars, f.chars); p.largeUsd += f.usd || 0; p.largeByTool[f.tool] = (p.largeByTool[f.tool] || 0) + 1; p.wastedCalls++; p.wastedUsd += f.usd || 0; }
    else if (f.kind === "cold-cache") p.coldSessions++;
  }
  return p;
}

/**
 * Context-cost attribution. A tool result enters the prompt once (cache write) and is
 * then re-read on every later API message in the same session until the next compaction.
 * cost ≈ tokens × (cache_write_1h + cache_read × later_messages). It is an estimate, but a
 * consistent one, so it ranks tools and files fairly against each other.
 */
function attribute(rec, s, msgTs, pricing, cpt) {
  const price = resolvePrice(pricing, rec.model);
  if (!price || rec.result.ts === null) return;
  const nextCompaction = s.compactions.find((c) => c > rec.result.ts);
  let alive = countAfter(msgTs, rec.result.ts);
  if (nextCompaction !== undefined) alive -= countAfter(msgTs, nextCompaction);
  const tokens = rec.result.chars / cpt;
  const write = price.cache_write_1h ?? price.input * 2;
  const read = price.cache_read ?? price.input * 0.1;
  rec.alive = alive;
  rec.ctxCost = (tokens / 1e6) * (write + read * alive);
}

function sortMap(map) {
  return [...map.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => ({ key: k, ...v }));
}
function sortBy(map, score) {
  return [...map.entries()].map(([k, v]) => ({ key: k, ...v })).sort((a, b) => score(a) - score(b));
}

/* ------------------------------------------------------------------ */
/* Calibration: compare our estimate with Claude Code's own cost-state  */
/* ------------------------------------------------------------------ */

export function calibrate(_model, bySession) {
  const perModel = new Map(); // model -> ratios[]
  const rows = [];
  for (const ss of bySession.values()) {
    if (ss.reported == null || ss.est <= 0 || ss.unknownModel) continue;
    const ratio = ss.reported / ss.est;
    rows.push({ sessionId: ss.session.id, model: ss.primaryModel || null, est: ss.est, reported: ss.reported, ratio });
    if (ss.primaryModel) bump(perModel, ss.primaryModel, () => []).push(ratio);
  }
  const models = [...perModel.entries()].map(([m, rs]) => {
    rs.sort((a, b) => a - b);
    return { model: m, sessions: rs.length, median: rs[rs.length >> 1], min: rs[0], max: rs[rs.length - 1] };
  });
  return { sessions: rows, models };
}

/* ------------------------------------------------------------------ */
/* Waste detection                                                     */
/* ------------------------------------------------------------------ */

export function detectWaste(calls, bySession, { largeOutput, repeatMin }) {
  const findings = [];

  // 1. Same read-like call repeated within one compaction epoch of one session.
  const groups = new Map();
  for (const c of calls) {
    if (!isReadLike(c.name)) continue;
    bump(groups, `${c.sessionId}\u0000${c.epoch}\u0000${c.key}`, () => []).push(c);
  }
  for (const list of groups.values()) {
    if (list.length < repeatMin) continue;
    const c = list[0];
    const chars = list.reduce((n, x) => n + (x.result?.chars || 0), 0);
    const usd = list.slice(1).reduce((n, x) => n + x.ctxCost, 0); // everything after the first read is waste
    findings.push({
      kind: "repeat",
      severity: list.length >= repeatMin + 3 ? "high" : "medium",
      sessionId: c.sessionId,
      project: c.project,
      tool: c.name,
      count: list.length,
      chars,
      usd,
      detail: c.preview,
      hint: "Same call repeated in one session; the output was already in context. Read a narrower range or keep notes.",
    });
  }

  // 2. Retry after error with the identical input.
  const byKey = new Map();
  for (const c of calls) bump(byKey, `${c.sessionId}\u0000${c.key}`, () => []).push(c);
  for (const list of byKey.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    let retries = 0;
    let usd = 0;
    for (let i = 1; i < list.length; i++) {
      if (list[i - 1].result?.isError) {
        retries++;
        usd += list[i].ctxCost;
      }
    }
    if (!retries) continue;
    const c = list[0];
    findings.push({
      kind: "retry",
      severity: retries >= 2 ? "high" : "low",
      sessionId: c.sessionId,
      project: c.project,
      tool: c.name,
      count: retries,
      chars: 0,
      usd,
      detail: c.preview,
      hint: "Identical call re-issued after it failed. Change the input before retrying.",
    });
  }

  // 3. Very large tool outputs.
  for (const c of calls) {
    const chars = c.result?.chars || 0;
    if (chars < largeOutput) continue;
    findings.push({
      kind: "large-output",
      severity: chars >= largeOutput * 3 ? "high" : "medium",
      sessionId: c.sessionId,
      project: c.project,
      tool: c.name,
      count: 1,
      chars,
      usd: c.ctxCost,
      detail: c.preview,
      hint: "Large tool output is re-sent on every later turn until compaction. Filter with head/grep or use limit.",
    });
  }

  // 4. Error-prone tools (per session).
  const perSessionTool = new Map();
  for (const c of calls) {
    const t = bump(perSessionTool, `${c.sessionId}\u0000${c.name}`, () => ({ c, calls: 0, errors: 0 }));
    t.calls++;
    if (c.result?.isError) t.errors++;
  }
  for (const t of perSessionTool.values()) {
    if (t.calls < 5 || t.errors / t.calls < 0.25) continue;
    findings.push({
      kind: "error-prone",
      severity: t.errors / t.calls >= 0.5 ? "high" : "medium",
      sessionId: t.c.sessionId,
      project: t.c.project,
      tool: t.c.name,
      count: t.errors,
      chars: 0,
      usd: 0,
      detail: `${t.errors}/${t.calls} calls failed`,
      hint: "A tool failing this often usually means a permission rule, a missing binary, or a wrong working directory.",
    });
  }

  // 5. Cold cache: big sessions with a poor cache hit rate.
  for (const ss of bySession.values()) {
    if (totalTokens(ss) < 500_000) continue;
    const hit = cacheHitRate(ss);
    if (hit >= 0.5) continue;
    findings.push({
      kind: "cold-cache",
      severity: hit < 0.25 ? "high" : "medium",
      sessionId: ss.session.id,
      project: ss.session.project,
      tool: "-",
      count: 1,
      chars: totalTokens(ss),
      usd: 0,
      detail: `cache hit ${(hit * 100).toFixed(0)}%`,
      hint: "Long idle gaps (past the cache TTL) or a changing system prompt make every turn re-pay the full prefix.",
    });
  }

  const rank = { high: 0, medium: 1, low: 2 };
  findings.sort((a, b) => rank[a.severity] - rank[b.severity] || b.usd - a.usd || b.chars - a.chars || b.count - a.count);
  return findings;
}
