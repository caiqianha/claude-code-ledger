/** Merge several `ccledger --json` exports (e.g. one per teammate) into one report. */

const MAXKEYS = new Set(["maxResultChars"]);

function addInto(dst, src) {
  for (const [k, v] of Object.entries(src)) {
    if (k === "key" || k === "name" || k === "session" || k === "tool" || k === "preview" || k === "primaryModel") {
      if (dst[k] == null) dst[k] = v;
      continue;
    }
    if (typeof v === "number") {
      if (MAXKEYS.has(k)) dst[k] = Math.max(dst[k] || 0, v);
      else dst[k] = (dst[k] || 0) + v;
    } else if (typeof v === "boolean") dst[k] = !!dst[k] || v;
    else if (v === null) dst[k] = dst[k] ?? null;
    else if (dst[k] == null) dst[k] = v;
  }
  return dst;
}

function mergeKeyed(lists, sortFn) {
  const map = new Map();
  for (const list of lists) for (const row of list || []) map.set(row.key, addInto(map.get(row.key) || {}, row));
  return [...map.values()].sort(sortFn);
}

export function mergeReports(reports) {
  const out = {
    range: {
      since: reports.some((r) => r.range?.since == null) ? null : Math.min(...reports.map((r) => r.range.since)),
      until: reports.some((r) => r.range?.until == null) ? null : Math.max(...reports.map((r) => r.range.until)),
      project: null,
    },
    totals: {},
    reported: { usd: 0, sessions: 0, of: 0 },
    byDay: mergeKeyed(reports.map((r) => r.byDay), (a, b) => (a.key < b.key ? -1 : 1)),
    byProject: mergeKeyed(reports.map((r) => r.byProject), (a, b) => b.est - a.est),
    byModel: mergeKeyed(reports.map((r) => r.byModel), (a, b) => b.est - a.est),
    byTool: mergeKeyed(reports.map((r) => r.byTool), (a, b) => b.calls - a.calls),
    byContext: mergeKeyed(reports.map((r) => r.byContext), (a, b) => b.ctxCost - a.ctxCost).slice(0, 200),
    bySession: reports.flatMap((r) => r.bySession || []).sort((a, b) => (b.reported ?? b.est) - (a.reported ?? a.est)),
    waste: reports.flatMap((r) => r.waste || []),
    sessionsIncluded: 0,
    calibration: { sessions: reports.flatMap((r) => r.calibration?.sessions || []), models: [] },
    meta: { dir: `${reports.length} merged reports`, files: 0, lines: 0, parseMs: 0 },
  };
  for (const r of reports) {
    addInto(out.totals, r.totals);
    out.reported.usd += r.reported?.usd || 0;
    out.reported.sessions += r.reported?.sessions || 0;
    out.reported.of += r.reported?.of || 0;
    out.sessionsIncluded += r.sessionsIncluded || 0;
    out.meta.files += r.meta?.files || 0;
    out.meta.lines += r.meta?.lines || 0;
  }
  const rank = { high: 0, medium: 1, low: 2 };
  out.waste.sort((a, b) => rank[a.severity] - rank[b.severity] || (b.usd || 0) - (a.usd || 0) || b.chars - a.chars);
  return out;
}
