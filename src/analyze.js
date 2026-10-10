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
    unknownModel: false,
    toolCalls: 0,
    toolErrors: 0,
    resultChars: 0,
  };
}

function addUsage(st, u, cost) {
  st.messages++;
  st.input += u.input;
  st.output += u.output;
  st.cacheRead += u.cacheRead;
  st.cacheWrite += u.cacheWrite5m + u.cacheWrite1h;
  st.thinking += u.thinking;
  if (cost === null) st.unknownModel = true;
  else st.est += cost;
}

export function totalTokens(st) {
  return st.input + st.output + st.cacheRead + st.cacheWrite;
}

export function cacheHitRate(st) {
  const denom = st.input + st.cacheRead + st.cacheWrite;
  return denom ? st.cacheRead / denom : 0;
}

function localDay(ts) {
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

/**
 * Aggregate a parsed model.
 * opts: { pricing, since?: ms, until?: ms, project?: string, largeOutput?: chars, repeatMin?: n }
 */
export function analyze(model, opts) {
  const { pricing } = opts;
  const since = opts.since ?? -Infinity;
  const until = opts.until ?? Infinity;
  const projFilter = opts.project ? opts.project.toLowerCase() : null;
  const largeOutput = opts.largeOutput ?? 30_000;
  const repeatMin = opts.repeatMin ?? 3;

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
  const includedSessions = new Set();

  // ---- messages / tokens ----
  for (const msg of model.messages.values()) {
    const s = model.sessions.get(msg.sessionId);
    if (!s || !sessionOk(s) || !tsOk(msg.ts)) continue;
    includedSessions.add(s.id);
    const cost = costOf(msg.usage, resolvePrice(pricing, msg.model));
    addUsage(totals, msg.usage, cost);
    if (msg.ts !== null) addUsage(bump(byDay, localDay(msg.ts), newStat), msg.usage, cost);
    addUsage(bump(byProject, s.project, newStat), msg.usage, cost);
    addUsage(bump(byModel, msg.model, newStat), msg.usage, cost);
    const ss = bump(bySession, s.id, () => ({ ...newStat(), session: s, reported: null }));
    addUsage(ss, msg.usage, cost);
  }

  // ---- tool calls ----
  const calls = [];
  for (const call of model.toolUses.values()) {
    const s = model.sessions.get(call.sessionId);
    if (!s || !sessionOk(s) || !tsOk(call.ts)) continue;
    const res = model.toolResults.get(call.id) || null;
    const rec = { ...call, result: res, project: s.project };
    calls.push(rec);
    const t = bump(byTool, call.name, () => ({
      name: call.name,
      calls: 0,
      errors: 0,
      noResult: 0,
      resultChars: 0,
      maxResultChars: 0,
      inputChars: 0,
    }));
    t.calls++;
    t.inputChars += call.inputChars;
    if (!res) t.noResult++;
    else {
      if (res.isError) t.errors++;
      t.resultChars += res.chars;
      if (res.chars > t.maxResultChars) t.maxResultChars = res.chars;
    }
    const bumpStat = (st) => {
      st.toolCalls++;
      if (res?.isError) st.toolErrors++;
      if (res) st.resultChars += res.chars;
    };
    bumpStat(totals);
    if (call.ts !== null) bumpStat(bump(byDay, localDay(call.ts), newStat));
    bumpStat(bump(byProject, s.project, newStat));
    bumpStat(bump(bySession, s.id, () => ({ ...newStat(), session: s, reported: null })));
  }

  // ---- reported cost from Claude Code's own cost-state (cumulative per session) ----
  let reported = 0;
  let reportedSessions = 0;
  for (const [sid, ss] of bySession) {
    const cs = model.costStates.get(sid);
    if (cs && typeof cs.totalCostUSD === "number") {
      ss.reported = cs.totalCostUSD;
      ss.linesAdded = cs.totalLinesAdded || 0;
      ss.linesRemoved = cs.totalLinesRemoved || 0;
      ss.apiMs = cs.totalAPIDuration || 0;
      ss.toolMs = cs.totalToolDuration || 0;
      reported += cs.totalCostUSD;
      reportedSessions++;
    }
  }

  const waste = detectWaste(calls, bySession, { largeOutput, repeatMin });

  return {
    range: { since: opts.since ?? null, until: opts.until ?? null, project: opts.project ?? null },
    totals,
    reported: { usd: reported, sessions: reportedSessions, of: bySession.size },
    byDay: sortMap(byDay),
    byProject: sortBy(byProject, (v) => -v.est),
    byModel: sortBy(byModel, (v) => -v.est),
    bySession: sortBy(bySession, (v) => -(v.reported ?? v.est)),
    byTool: sortBy(byTool, (v) => -v.calls),
    waste,
    sessionsIncluded: includedSessions.size,
  };
}

function sortMap(map) {
  return [...map.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => ({ key: k, ...v }));
}
function sortBy(map, score) {
  return [...map.entries()].map(([k, v]) => ({ key: k, ...v })).sort((a, b) => score(a) - score(b));
}

/* ------------------------------------------------------------------ */
/* Waste detection                                                     */
/* ------------------------------------------------------------------ */

export function detectWaste(calls, bySession, { largeOutput, repeatMin }) {
  const findings = [];

  // 1. Same read-like call repeated in one session.
  const groups = new Map();
  for (const c of calls) {
    if (!isReadLike(c.name)) continue;
    const g = bump(groups, `${c.sessionId}\u0000${c.key}`, () => ({ c, list: [] }));
    g.list.push(c);
  }
  for (const { c, list } of groups.values()) {
    if (list.length < repeatMin) continue;
    const chars = list.reduce((n, x) => n + (x.result?.chars || 0), 0);
    findings.push({
      kind: "repeat",
      severity: list.length >= repeatMin + 2 ? "high" : "medium",
      sessionId: c.sessionId,
      project: c.project,
      tool: c.name,
      count: list.length,
      chars,
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
    for (let i = 1; i < list.length; i++) {
      if (list[i - 1].result?.isError) retries++;
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
      detail: `cache hit ${(hit * 100).toFixed(0)}%`,
      hint: "Long idle gaps (past the cache TTL) or a changing system prompt make every turn re-pay the full prefix.",
    });
  }

  const rank = { high: 0, medium: 1, low: 2 };
  findings.sort((a, b) => rank[a.severity] - rank[b.severity] || b.chars - a.chars || b.count - a.count);
  return findings;
}
