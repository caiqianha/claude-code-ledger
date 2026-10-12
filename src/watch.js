import fs from "node:fs";
import path from "node:path";
import { listSessionFiles } from "./loader.js";
import { buildModel, newModel } from "./parse.js";
import { analyze, totalTokens, cacheHitRate } from "./analyze.js";
import { table, kv, heading, fmtNum, fmtUsd, fmtPct, fmtDur, fmtMs, fmtTime, short, c } from "./render.js";

function pickFile(dir, filter) {
  const files = listSessionFiles(dir);
  const cand = filter ? files.filter((f) => path.basename(f.file).includes(filter)) : files;
  let best = null;
  for (const f of cand) {
    const st = fs.statSync(f.file);
    if (!best || st.mtimeMs > best.mtimeMs) best = { ...f, mtimeMs: st.mtimeMs };
  }
  return best;
}

/** Incremental reader: keeps a byte offset and a partial-line buffer per file. */
function makeTail(entry) {
  let offset = 0;
  let rest = "";
  return function readNew() {
    const size = fs.statSync(entry.file).size;
    if (size < offset) {
      offset = 0;
      rest = "";
    }
    if (size === offset) return [];
    const fd = fs.openSync(entry.file, "r");
    const buf = Buffer.alloc(size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    fs.closeSync(fd);
    offset = size;
    const text = rest + buf.toString("utf8");
    const lines = text.split("\n");
    rest = lines.pop();
    const out = [];
    for (const line of lines) {
      if (!line) continue;
      try {
        const rec = JSON.parse(line);
        rec._projectDir = entry.projectDir;
        rec._fileSession = path.basename(entry.file, ".jsonl");
        rec._file = entry.file;
        out.push(rec);
      } catch {
        /* skip partial / malformed */
      }
    }
    return out;
  };
}

export async function watch({ dir, session, pricing, interval = 1000, out = process.stdout, once = false }) {
  let entry = pickFile(dir, session);
  if (!entry) throw new Error(`No session logs under ${dir}`);
  let model = newModel();
  let tail = makeTail(entry);
  let lastRepick = Date.now();
  let dirty = true;

  const render = () => {
    const r = analyze(model, { pricing });
    const ss = r.bySession[0];
    const s = ss?.session;
    let last = null;
    for (const m of model.messages.values()) if (m.ts !== null && (!last || m.ts > last.ts)) last = m;
    const ctxNow = last ? last.usage.input + last.usage.cacheRead + last.usage.cacheWrite5m + last.usage.cacheWrite1h : 0;
    const calls = [...model.toolUses.values()].sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, 10).reverse();
    const rows = calls.map((call) => {
      const res = model.toolResults.get(call.id);
      return { time: fmtTime(call.ts), tool: call.name, preview: call.preview, chars: res ? res.chars : null, ms: res && res.ts !== null && call.ts !== null ? res.ts - call.ts : null, status: !res ? c.dim("…") : res.isError ? c.red("error") : c.green("ok") };
    });
    const parts = [];
    parts.push(c.bold(`ccledger watch`) + c.dim(`  ${s ? s.project : "-"} · ${short(path.basename(entry.file))} · ${last ? last.model : "-"} · ${fmtTime(Date.now())}`));
    if (ss) {
      parts.push(
        kv([
          ["cost", `${fmtUsd(ss.est, ss.unknownModel)} est` + (ss.reported != null ? `  ·  ${fmtUsd(ss.reported)} reported` : "") + (ss.sub ? `  ·  ${fmtUsd(ss.sub)} subagents` : "")],
          ["context now", `${fmtNum(ctxNow)} tokens` + (last?.usage.cacheRead ? `  (cache hit ${fmtPct(cacheHitRate(ss))})` : "")],
          ["tokens", `${fmtNum(totalTokens(ss))}  (in ${fmtNum(ss.input)} · out ${fmtNum(ss.output)} · cache rd ${fmtNum(ss.cacheRead)} · wr ${fmtNum(ss.cacheWrite)})`],
          ["turns / msgs", `${s.humanTurns} / ${ss.messages}` + (s.compactions.length ? `  ·  ${s.compactions.length} compaction${s.compactions.length > 1 ? "s" : ""}` : "")],
          ["tool calls", `${ss.toolCalls}  (${ss.toolErrors} errors, ${fmtNum(ss.resultChars)} chars, ~${fmtUsd(ss.ctxCost)} context cost)`],
          ["elapsed", fmtDur((s.lastTs || 0) - (s.firstTs || 0))],
        ]),
      );
    }
    parts.push(heading("Recent tool calls"));
    parts.push(
      rows.length
        ? table(rows, [
            { key: "time", label: "time" },
            { key: "tool", label: "tool", max: 30 },
            { key: "preview", label: "input", max: 56 },
            { key: "chars", label: "chars", align: "r", fmt: fmtNum },
            { key: "ms", label: "took", align: "r", fmt: fmtMs },
            { key: "status", label: "status" },
          ])
        : c.dim("none yet"),
    );
    if (r.waste.length) {
      parts.push(heading("Flags"));
      for (const f of r.waste.slice(0, 3)) parts.push(`  ${f.severity === "high" ? c.red("●") : c.yellow("●")} ${f.kind} ${c.dim(f.tool)} ${f.detail}${f.count > 1 ? c.dim(` ×${f.count}`) : ""}`);
    }
    parts.push(c.dim(`\nCtrl-C to quit · ${entry.file}`));
    out.write((once ? "" : "\x1b[2J\x1b[H") + parts.join("\n") + "\n");
  };

  const step = async () => {
    if (!session && Date.now() - lastRepick > 5000) {
      lastRepick = Date.now();
      const latest = pickFile(dir);
      if (latest && latest.file !== entry.file) {
        entry = latest;
        model = newModel();
        tail = makeTail(entry);
        dirty = true;
      }
    }
    const recs = tail();
    if (recs.length) {
      await buildModel(recs, model);
      dirty = true;
    }
    if (dirty) {
      render();
      dirty = false;
    }
  };

  await step();
  if (once) return;
  return new Promise((resolve) => {
    const timer = setInterval(() => step().catch((e) => out.write(String(e) + "\n")), interval);
    process.on("SIGINT", () => {
      clearInterval(timer);
      out.write("\n");
      resolve();
    });
  });
}
