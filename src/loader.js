import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

/** Default location of Claude Code session logs. */
export function defaultDir() {
  return path.join(os.homedir(), ".claude", "projects");
}

/** List every *.jsonl under <dir>/<project>/ (recursively, so subagent logs are included). */
export function listSessionFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    walk(path.join(dir, ent.name), (file) => {
      if (file.endsWith(".jsonl")) out.push({ file, projectDir: ent.name });
    });
  }
  return out;
}

function walk(dir, cb) {
  let ents;
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of ents) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, cb);
    else if (ent.isFile()) cb(p);
  }
}

/**
 * Stream parsed JSONL records. Malformed lines are skipped.
 * Each record gets `_projectDir` and `_fileSession` (session id derived from the file name).
 */
export async function* iterRecords(files) {
  for (const { file, projectDir } of files) {
    const fileSession = path.basename(file, ".jsonl");
    const rl = readline.createInterface({
      input: fs.createReadStream(file, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      if (!line) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (!rec || typeof rec !== "object") continue;
      rec._projectDir = projectDir;
      rec._fileSession = fileSession;
      rec._file = file;
      yield rec;
    }
  }
}

/**
 * Read complete JSONL records from `file` starting at byte `offset`.
 * Returns the parsed records and the offset just past the last full line,
 * so callers can resume later without re-reading the file.
 */
export function readRecordsFrom(file, offset = 0, meta = {}) {
  const size = fs.statSync(file).size;
  if (size < offset) offset = 0; // file was truncated / rotated
  if (size === offset) return { records: [], offset };
  const fd = fs.openSync(file, "r");
  const buf = Buffer.alloc(size - offset);
  fs.readSync(fd, buf, 0, buf.length, offset);
  fs.closeSync(fd);
  const end = buf.lastIndexOf(0x0a);
  if (end === -1) return { records: [], offset }; // only a partial line so far
  const text = buf.subarray(0, end).toString("utf8");
  const records = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      const rec = JSON.parse(line);
      rec._projectDir = meta.projectDir ?? path.basename(path.dirname(file));
      rec._fileSession = path.basename(file, ".jsonl");
      rec._file = file;
      records.push(rec);
    } catch {
      /* skip malformed */
    }
  }
  return { records, offset: offset + end + 1 };
}
