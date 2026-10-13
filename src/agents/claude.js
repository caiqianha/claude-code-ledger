/* Claude Code: ~/.claude/projects/<project>/<session>.jsonl (see loader.js and parse.js). */
import { defaultDir, listSessionFiles, iterRecords } from "../loader.js";
import { claudeTurn } from "../parse.js";

export const claude = {
  name: "claude",
  label: "Claude Code",
  location: "~/.claude/projects/**/*.jsonl",
  defaultDirs: () => [process.env.CCLEDGER_DIR || defaultDir()],
  listFiles: (dirs) => dirs.flatMap((d) => listSessionFiles(d)),
  async *read(entries) {
    for await (const rec of iterRecords(entries)) yield claudeTurn(rec);
  },
};
