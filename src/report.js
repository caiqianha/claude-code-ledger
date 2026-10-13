/* Single-file HTML report. No external assets; light/dark via prefers-color-scheme. */
import { totalTokens, cacheHitRate } from "./analyze.js";
import { fmtNum, fmtUsd, fmtPct, fmtDur, fmtDate, short } from "./render.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);

function htmlTable(rows, cols) {
  const th = cols.map((col) => `<th class="${col.align === "r" ? "r" : ""}">${esc(col.label)}</th>`).join("");
  const body = rows
    .map((r) => `<tr>${cols.map((col) => `<td class="${col.align === "r" ? "r num" : ""}">${esc(col.fmt ? col.fmt(r[col.key], r) : r[col.key] ?? "-")}</td>`).join("")}</tr>`)
    .join("\n");
  return `<div class="tw"><table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table></div>`;
}

/** Daily cost bars: one series, one hue, rounded data-ends, baseline, per-bar tooltip. */
function dailyChart(days) {
  if (!days.length) return "";
  const W = 960, H = 240, padL = 44, padR = 8, padT = 16, padB = 36;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const max = Math.max(...days.map((d) => d.est), 0.01);
  const n = days.length;
  const slot = innerW / n;
  const bw = Math.max(2, Math.min(28, slot - 2));
  const ticks = 4;
  const grid = [];
  for (let i = 0; i <= ticks; i++) {
    const v = (max * i) / ticks;
    const y = padT + innerH - (v / max) * innerH;
    grid.push(`<line x1="${padL}" x2="${W - padR}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" class="grid"/><text x="${padL - 6}" y="${(y + 4).toFixed(1)}" class="tick" text-anchor="end">$${v >= 10 ? v.toFixed(0) : v.toFixed(1)}</text>`);
  }
  const bars = days
    .map((d, i) => {
      const h = (d.est / max) * innerH;
      const x = padL + i * slot + (slot - bw) / 2;
      const y = padT + innerH - h;
      const r = Math.min(4, bw / 2, h);
      const path = h <= 0 ? "" : `M${x},${padT + innerH} V${y + r} a${r},${r} 0 0 1 ${r},-${r} H${x + bw - r} a${r},${r} 0 0 1 ${r},${r} V${padT + innerH} Z`;
      const label = `${d.key}: ${fmtUsd(d.est)} est${d.reported != null ? `, ${fmtUsd(d.reported)} reported` : ""}, ${fmtNum(totalTokens(d))} tokens, ${d.toolCalls} tool calls`;
      return `<g class="bar" tabindex="0" role="img" aria-label="${esc(label)}"><rect x="${(padL + i * slot).toFixed(1)}" y="${padT}" width="${slot.toFixed(1)}" height="${innerH}" class="hit"/><path d="${path}"/><title>${esc(label)}</title></g>`;
    })
    .join("");
  const every = Math.ceil(n / 12);
  const labels = days
    .map((d, i) => (i % every === 0 || i === n - 1 ? `<text x="${(padL + i * slot + slot / 2).toFixed(1)}" y="${H - 12}" class="tick" text-anchor="middle">${esc(d.key.slice(5))}</text>` : ""))
    .join("");
  return `<figure><figcaption>Estimated cost per day</figcaption><svg viewBox="0 0 ${W} ${H}" width="100%" role="group" aria-label="Estimated cost per day">${grid.join("")}<line x1="${padL}" x2="${W - padR}" y1="${padT + innerH}" y2="${padT + innerH}" class="axis"/>${bars}${labels}</svg></figure>`;
}

export function renderHtml(r, { title = "ccledger report" } = {}) {
  const t = r.totals;
  const range = [r.range.since ? `since ${new Date(r.range.since).toLocaleDateString("sv-SE")}` : "all time", r.range.project ? `project ~ "${r.range.project}"` : null].filter(Boolean).join(" · ");
  const tile = (label, value, sub = "") => `<div class="tile"><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div>${sub ? `<div class="sub">${esc(sub)}</div>` : ""}</div>`;
  const tiles = [
    tile("Estimated cost", fmtUsd(t.est, t.unknownModel), r.reported.sessions ? `${fmtUsd(r.reported.usd)} reported by Claude Code (${r.reported.sessions}/${r.reported.of} sessions)` : ""),
    tile("Tokens", fmtNum(totalTokens(t)), `cache hit ${fmtPct(cacheHitRate(t))}`),
    tile("Tool calls", fmtNum(t.toolCalls), `${t.toolErrors} errors · ~${fmtUsd(t.ctxCost)} context cost`),
    tile("Sessions", String(r.sessionsIncluded), t.sub ? `${fmtUsd(t.sub)} by subagents` : ""),
    tile("Waste findings", String(r.waste.length), r.waste.filter((f) => f.severity === "high").length + " high"),
  ].join("");
  const tokenCols = [
    { key: "input", label: "input", align: "r", fmt: fmtNum },
    { key: "output", label: "output", align: "r", fmt: fmtNum },
    { key: "cacheRead", label: "cache rd", align: "r", fmt: fmtNum },
    { key: "cacheWrite", label: "cache wr", align: "r", fmt: fmtNum },
    { key: "_hit", label: "hit", align: "r", fmt: (_, row) => fmtPct(cacheHitRate(row)) },
    { key: "est", label: "est $", align: "r", fmt: (v, row) => (row.noPricing ? "n/a" : fmtUsd(v, row.unknownModel)) },
  ];
  const multiAgent = (r.byAgent || []).length > 1 || (r.byAgent || []).some((a) => a.key !== "claude");
  const estFmt = (v, row) => (row.noPricing ? "n/a" : fmtUsd(v, row.unknownModel));
  const sections = [
    ...(multiAgent ? [["By agent", htmlTable(r.byAgent, [{ key: "key", label: "agent" }, { key: "messages", label: "msgs", align: "r", fmt: fmtNum }, ...tokenCols, { key: "toolCalls", label: "tools", align: "r" }, { key: "toolErrors", label: "errs", align: "r" }])]] : []),
    ["Daily", dailyChart(r.byDay) + htmlTable(r.byDay, [{ key: "key", label: "day" }, { key: "messages", label: "msgs", align: "r", fmt: fmtNum }, ...tokenCols, { key: "reported", label: "reported $", align: "r", fmt: (v) => (v == null ? "-" : fmtUsd(v)) }, { key: "toolCalls", label: "tools", align: "r" }])],
    ["By model", htmlTable(r.byModel, [{ key: "key", label: "model" }, { key: "messages", label: "msgs", align: "r", fmt: fmtNum }, ...tokenCols])],
    ["By project", htmlTable(r.byProject, [{ key: "key", label: "project" }, { key: "messages", label: "msgs", align: "r", fmt: fmtNum }, ...tokenCols, { key: "toolCalls", label: "tools", align: "r" }])],
    ["Tools", htmlTable(r.byTool, [{ key: "key", label: "tool" }, { key: "calls", label: "calls", align: "r" }, { key: "errors", label: "errs", align: "r" }, { key: "resultChars", label: "out chars", align: "r", fmt: fmtNum }, { key: "maxResultChars", label: "max", align: "r", fmt: fmtNum }, { key: "ctxCost", label: "context $", align: "r", fmt: (v) => fmtUsd(v) }])],
    ["Most expensive context", htmlTable(r.byContext.slice(0, 25), [{ key: "tool", label: "tool" }, { key: "preview", label: "input" }, { key: "calls", label: "calls", align: "r" }, { key: "sessions", label: "sessions", align: "r" }, { key: "chars", label: "chars", align: "r", fmt: fmtNum }, { key: "ctxCost", label: "context $", align: "r", fmt: (v) => fmtUsd(v) }])],
    ["Sessions", htmlTable(r.bySession.slice(0, 40), [{ key: "key", label: "session", fmt: (v) => short(v) }, ...(multiAgent ? [{ key: "session", label: "agent", fmt: (s) => s.agent || "claude" }] : []), { key: "session", label: "started", fmt: (s) => fmtDate(s.firstTs) }, { key: "session", label: "project", fmt: (s) => s.project }, { key: "session", label: "wall", align: "r", fmt: (s) => fmtDur(s.lastTs - s.firstTs) }, { key: "session", label: "turns", align: "r", fmt: (s) => s.humanTurns }, { key: "_tok", label: "tokens", align: "r", fmt: (_, row) => (row.estimated ? "~" : "") + fmtNum(totalTokens(row)) }, { key: "_hit", label: "hit", align: "r", fmt: (_, row) => fmtPct(cacheHitRate(row)) }, { key: "toolCalls", label: "tools", align: "r" }, { key: "est", label: "est $", align: "r", fmt: estFmt }, { key: "reported", label: "reported $", align: "r", fmt: (v) => (v == null ? "-" : fmtUsd(v)) }])],
    ["Waste", htmlTable(r.waste.slice(0, 60), [{ key: "severity", label: "sev" }, { key: "kind", label: "kind" }, { key: "tool", label: "tool" }, { key: "count", label: "n", align: "r" }, { key: "chars", label: "chars", align: "r", fmt: fmtNum }, { key: "usd", label: "~$", align: "r", fmt: (v) => fmtUsd(v || 0) }, { key: "project", label: "project" }, { key: "sessionId", label: "session", fmt: (v) => short(v) }, { key: "detail", label: "detail" }])],
  ]
    .map(([h, body]) => `<section><h2>${esc(h)}</h2>${body}</section>`)
    .join("\n");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
:root{--bg:#fcfcfb;--fg:#0b0b0b;--fg2:#52514e;--line:#e6e5e1;--tile:#f3f2ee;--bar:#2a78d6;--bar-hover:#1c5cab;--grid:#e6e5e1}
@media(prefers-color-scheme:dark){:root{--bg:#1a1a19;--fg:#f0efec;--fg2:#c3c2b7;--line:#33332f;--tile:#242422;--bar:#3987e5;--bar-hover:#6da7ec;--grid:#33332f}}
*{box-sizing:border-box}body{margin:0;padding:24px 16px 48px;background:var(--bg);color:var(--fg);font:14px/1.45 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:1100px;margin:0 auto}h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:32px 0 10px}.meta{color:var(--fg2);margin-bottom:20px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px}.tile{background:var(--tile);border-radius:10px;padding:12px 14px}.tile .label{color:var(--fg2);font-size:12px}.tile .value{font-size:24px;font-weight:600;font-variant-numeric:tabular-nums;margin:2px 0}.tile .sub{color:var(--fg2);font-size:12px}
figure{margin:0 0 12px}figcaption{color:var(--fg2);font-size:12px;margin-bottom:4px}svg{display:block;overflow:visible}.grid{stroke:var(--grid);stroke-width:1}.axis{stroke:var(--fg2);stroke-width:1}.tick{fill:var(--fg2);font-size:11px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.bar path{fill:var(--bar)}.bar .hit{fill:transparent}.bar:hover path,.bar:focus path{fill:var(--bar-hover)}.bar:focus{outline:none}
.tw{overflow-x:auto;border:1px solid var(--line);border-radius:8px}table{border-collapse:collapse;width:100%;font-size:13px}th,td{padding:6px 10px;border-bottom:1px solid var(--line);text-align:left;white-space:nowrap}th{color:var(--fg2);font-weight:500;background:var(--tile);position:sticky;top:0}tr:last-child td{border-bottom:0}.r{text-align:right}.num{font-variant-numeric:tabular-nums;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
footer{color:var(--fg2);font-size:12px;margin-top:32px}
</style></head><body><main>
<h1>${esc(title)}</h1>
<div class="meta">${esc(range)} · ${r.meta ? `${r.meta.files} files · ${fmtNum(r.meta.lines)} lines` : ""} · generated ${esc(new Date().toISOString().slice(0, 16).replace("T", " "))}</div>
<div class="tiles">${tiles}</div>
${sections}
<footer>Estimated costs use list prices per model; "reported" is Claude Code's own cost-state. "~" marks token counts estimated from text length; "n/a" marks agents without per-token billing (Cursor). Context cost ≈ tokens of a tool result × (one cache write + one cache read per later message until compaction). Generated by ccledger; no message content is included.</footer>
</main></body></html>`;
}
