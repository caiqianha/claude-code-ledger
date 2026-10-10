/* Minimal dependency-free terminal rendering. */

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
  const s = n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2);
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

export function fmtDate(ts) {
  if (!ts) return "-";
  const d = new Date(ts);
  return d.toLocaleDateString("sv-SE") + " " + d.toTimeString().slice(0, 5);
}

export function short(id, n = 8) {
  return String(id || "").slice(0, n);
}

function width(str) {
  let w = 0;
  for (const ch of String(str)) w += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1;
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
    cols.map((c) => {
      let v = c.fmt ? c.fmt(r[c.key], r) : r[c.key];
      v = v == null ? "-" : String(v);
      return c.max ? truncate(v, c.max) : v;
    }),
  );
  const widths = cols.map((c, i) => Math.max(width(c.label), ...cells.map((row) => width(row[i]))));
  const line = (vals) => vals.map((v, i) => pad(v, widths[i], cols[i].align || "l")).join("  ");
  const out = [line(cols.map((c) => c.label)), line(widths.map((w) => "─".repeat(w)))];
  for (const row of cells) out.push(line(row));
  return out.join("\n");
}

export function heading(text) {
  return `\n${text}\n${"═".repeat(width(text))}`;
}

export function kv(pairs) {
  const w = Math.max(...pairs.map(([k]) => width(k)));
  return pairs.map(([k, v]) => `${pad(k, w, "l")}  ${v}`).join("\n");
}
