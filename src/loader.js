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
