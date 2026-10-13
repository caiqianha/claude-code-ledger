/* Before/after comparison of waste, tokens, cache and cost per session. */
import { analyze, totalTokens, cacheHitRate } from "./analyze.js";
import { table, heading, fmtNum, fmtUsd, fmtPct, c } from "./render.js";

const DAY = 86_400_000;

/** "7d" | "24h" | "2w" -> milliseconds, or null. */
export function durationMs(v) {
  const m = /^(\d+)([dhw])$/.exec(String(v || "").trim());
  if (!m) return null;
  return Number(m[1]) * { h: 3_600_000, d: DAY, w: 7 * DAY }[m[2]];
}

/** "20 sessions" -> 20, or null. */
export function sessionCount(v) {
  const m = /^(\d+)\s*(sessions?|s)$/i.exec(String(v || "").trim());
  return m ? Number(m[1]) : null;
}

/**
 * Compute the two windows. after = [since, until]; before = the `baseline` duration (or the same
 * length as `after`) ending right before `since`, or the N sessions that started before `since`.
 */
export function windows(model, { since, until, baseline, now = Date.now() }) {
  const aSince = since ?? now - 7 * DAY;
  const aUntil = until ?? now;
  const n = sessionCount(baseline);
  if (n) {
    const starts = [...model.sessions.values()].map((s) => s.firstTs).filter((t) => t !== null && t < aSince).sort((a, b) => a - b);
    const picked = starts.slice(-n);
    return { after: { since: aSince, until: aUntil }, before: { since: picked.length ? picked[0] : aSince - (aUntil - aSince), until: aSince - 1, sessions: picked.length } };
  }
  const len = durationMs(baseline) ?? Math.max(aUntil - aSince, DAY);
  return { after: { since: aSince, until: aUntil }, before: { since: aSince - len, until: aSince - 1 } };
}

export function metricsOf(report) {
  const t = report.totals;
  const p = report.patterns || {};
  const n = report.sessionsIncluded || 0;
  const reported = report.bySession.filter((s) => s.reported != null);
  return {
    sessions: n,
    wasteRate: p.toolCalls ? p.wastedCalls / p.toolCalls : 0,
    wastedUsd: p.wastedUsd || 0,
    tokensPerSession: n ? totalTokens(t) / n : 0,
    cacheHit: cacheHitRate(t),
    costPerSession: n ? t.est / n : 0,
    reportedPerSession: reported.length ? reported.reduce((a, s) => a + s.reported, 0) / reported.length : null,
    callsPerSession: n ? t.toolCalls / n : 0,
    errorRate: t.toolCalls ? t.toolErrors / t.toolCalls : 0,
    findings: report.waste.length,
    est: t.est,
    unknownModel: t.unknownModel,
  };
}

const ROWS = [
  { key: "sessions", label: "sessions", fmt: (v) => String(v), delta: "none" },
  { key: "wasteRate", label: "waste rate (wasteful calls / tool calls)", fmt: fmtPct, delta: "pts", lowerIsBetter: true, weight: 1 },
  { key: "tokensPerSession", label: "avg tokens / session", fmt: fmtNum, delta: "rel", lowerIsBetter: true, weight: 1 },
  { key: "cacheHit", label: "cache hit rate", fmt: fmtPct, delta: "pts", lowerIsBetter: false, weight: 1 },
  { key: "costPerSession", label: "est cost / session", fmt: (v, m) => fmtUsd(v, m.unknownModel), delta: "rel", lowerIsBetter: true, weight: 1 },
  { key: "reportedPerSession", label: "reported cost / session", fmt: (v) => (v == null ? "-" : fmtUsd(v)), delta: "rel", lowerIsBetter: true, weight: 0 },
  { key: "callsPerSession", label: "tool calls / session", fmt: (v) => v.toFixed(1), delta: "rel", lowerIsBetter: true, weight: 0 },
  { key: "errorRate", label: "tool error rate", fmt: fmtPct, delta: "pts", lowerIsBetter: true, weight: 0.5 },
  { key: "findings", label: "waste findings", fmt: (v) => String(v), delta: "none" },
];

function deltaOf(row, a, b) {
  if (row.delta === "none" || a == null || b == null) return { text: "", score: 0 };
  if (row.delta === "pts") {
    const d = (b - a) * 100;
    const good = row.lowerIsBetter ? d <= -3 : d >= 3;
    const bad = row.lowerIsBetter ? d >= 3 : d <= -3;
    return { text: `${d >= 0 ? "+" : ""}${d.toFixed(0)} pts`, score: good ? 1 : bad ? -1 : 0 };
  }
  if (!a) return { text: b ? "new" : "", score: 0 };
  const r = (b - a) / a;
  const good = row.lowerIsBetter ? r <= -0.1 : r >= 0.1;
  const bad = row.lowerIsBetter ? r >= 0.1 : r <= -0.1;
  return { text: `${r >= 0 ? "+" : ""}${(r * 100).toFixed(0)}%`, score: good ? 1 : bad ? -1 : 0 };
}

/** Compare two windows of one model. Returns { before, after, rows, score, verdict }. */
export function compare(model, pricing, { after, before, largeOutput, project }) {
  const rb = analyze(model, { pricing, since: before.since, until: before.until, largeOutput, project });
  const ra = analyze(model, { pricing, since: after.since, until: after.until, largeOutput, project });
  const mb = metricsOf(rb);
  const ma = metricsOf(ra);
  const rows = ROWS.map((row) => {
    const d = deltaOf(row, mb[row.key], ma[row.key]);
    return { key: row.key, label: row.label, before: row.fmt(mb[row.key], mb), after: row.fmt(ma[row.key], ma), delta: d.text, score: d.score, weight: row.weight || 0 };
  });
  const score = rows.reduce((n, r) => n + r.score * r.weight, 0);
  let verdict;
  if (!mb.sessions || !ma.sessions) verdict = `Not enough data: ${mb.sessions} session${mb.sessions === 1 ? "" : "s"} before, ${ma.sessions} after.`;
  else {
    const parts = rows.filter((r) => r.weight && r.delta && r.score).map((r) => `${r.label.replace(/ \(.*\)/, "")} ${r.delta}`);
    const word = score >= 1 ? "Better" : score <= -1 ? "Worse" : "No clear change";
    verdict = `${word}${parts.length ? ": " + parts.join(", ") : ""} (${mb.sessions} vs ${ma.sessions} sessions).`;
  }
  return { before: { ...before, metrics: mb }, after: { ...after, metrics: ma }, rows, score, verdict };
}

const day = (ts) => new Date(ts).toLocaleDateString("sv-SE");

export function renderCompare(cmp, { beforeLabel = "before", afterLabel = "after" } = {}) {
  const parts = [heading("Compare")];
  parts.push(c.dim(`${beforeLabel}: ${day(cmp.before.since)} → ${day(cmp.before.until)}${cmp.before.sessions != null ? ` (${cmp.before.sessions} sessions)` : ""}   ${afterLabel}: ${day(cmp.after.since)} → ${day(cmp.after.until)}`));
  parts.push(
    table(cmp.rows, [
      { key: "label", label: "metric" },
      { key: "before", label: beforeLabel, align: "r" },
      { key: "after", label: afterLabel, align: "r" },
      { key: "delta", label: "delta", align: "r", fmt: (v, r) => (r.score > 0 ? c.green(v) : r.score < 0 ? c.red(v) : v) },
    ]),
  );
  const v = cmp.verdict;
  parts.push("\n" + (v.startsWith("Better") ? c.green(c.bold(v)) : v.startsWith("Worse") ? c.red(c.bold(v)) : c.bold(v)));
  parts.push(c.dim("deltas: relative change for averages, percentage points for rates; green/red when past 10% / 3 pts"));
  return parts.join("\n");
}
