/* Minimal dependency-free terminal rendering. */

let colorOn = false;
export function setColor(on) {
  colorOn = !!on;
}
const wrap = (code) => (s) => (colorOn ? `\x1b[${code}m${s}\x1b[0m` : String(s));
export const c = {
  bold: wrap("1"),
  dim: wrap("2"),
  red: wrap("31"),
  green: wrap("32"),
  yellow: wrap("33"),
  blue: wrap("34"),
  magenta: wrap("35"),
  cyan: wrap("36"),
};
export function sev(s) {
  return s === "high" ? c.red(s) : s === "medium" ? c.yellow(s) : c.dim(s);
}

export function fmtNum(n) {
  if (n == null) return "-";
  const a = Math.abs(n);
  if (a < 1000) return String(Math.round(n));
  if (a < 1e6) return (n / 1e3).toFixed(1) + "k";
  if (a < 1e9) return (n / 1e6).toFixed(2) + "M";
  return (n / 1e9).toFixed(2) + "B";
}

export function fmtUsd(n, unknown = false) {
  if (n == null) return "?";
  const a = Math.abs(n);
  const s = a >= 100 ? n.toFixed(0) : a >= 10 ? n.toFixed(1) : a >= 0.01 || a === 0 ? n.toFixed(2) : n.toFixed(3);
  return "$" + s + (unknown ? "+" : "");
}

export function fmtPct(x) {
  return (x * 100).toFixed(0) + "%";
}

export function fmtDur(ms) {
  if (!ms) return "-";
  const m = Math.round(ms / 60000);
  if (m < 60) return m + "m";
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, "0")}`;
}

export function fmtMs(ms) {
  if (ms == null) return "-";
  if (ms < 1000) return Math.round(ms) + "ms";
  if (ms < 60_000) return (ms / 1000).toFixed(1) + "s";
  return fmtDur(ms);
}

export function fmtDate(ts) {
  if (!ts) return "-";
  const d = new Date(ts);
  return d.toLocaleDateString("sv-SE") + " " + d.toTimeString().slice(0, 5);
}

export function fmtTime(ts) {
  if (!ts) return "-";
  return new Date(ts).toTimeString().slice(0, 8);
}

export function short(id, n = 8) {
  return String(id || "").slice(0, n);
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;
function width(str) {
  let w = 0;
  for (const ch of String(str).replace(ANSI, "")) w += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1;
  return w;
}

export function truncate(str, max) {
  str = String(str ?? "");
  if (width(str) <= max) return str;
  let out = "";
  for (const ch of str) {
    if (width(out + ch) > max - 1) break;
    out += ch;
  }
  return out + "…";
}

function pad(str, w, align) {
  const s = String(str);
  const fill = Math.max(0, w - width(s));
  return align === "r" ? " ".repeat(fill) + s : s + " ".repeat(fill);
}

/**
 * cols: [{ key, label, align?: "l"|"r", fmt?: (v,row)=>string, max?: number }]
 */
export function table(rows, cols) {
  const cells = rows.map((r) =>
    cols.map((col) => {
      let v = col.fmt ? col.fmt(r[col.key], r) : r[col.key];
      v = v == null ? "-" : String(v);
      return col.max ? truncate(v, col.max) : v;
    }),
  );
  const widths = cols.map((col, i) => Math.max(width(col.label), ...cells.map((row) => width(row[i]))));
  const line = (vals) => vals.map((v, i) => pad(v, widths[i], cols[i].align || "l")).join("  ");
  const out = [c.dim(line(cols.map((col) => col.label))), c.dim(line(widths.map((w) => "─".repeat(w))))];
  for (const row of cells) out.push(line(row));
  return out.join("\n");
}

export function heading(text) {
  return `\n${c.bold(text)}\n${c.dim("═".repeat(width(text)))}`;
}

export function kv(pairs) {
  const w = Math.max(...pairs.map(([k]) => width(k)));
  return pairs.map(([k, v]) => `${c.dim(pad(k, w, "l"))}  ${v}`).join("\n");
}
