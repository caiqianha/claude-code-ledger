/**
 * Log readers for the supported coding agents. Each reader exposes
 *   name, label, location (for --help), defaultDirs(), listFiles(dirs) -> [{file, ...}],
 *   read(entries) -> async iterable of normalized turns (see ingestTurn in parse.js),
 *   unavailable?() -> string reason when the reader cannot run on this machine.
 */
import { claude } from "./claude.js";
import { codex } from "./codex.js";
import { gemini } from "./gemini.js";
import { cursor } from "./cursor.js";

export const AGENTS = { claude, codex, gemini, cursor };
export const AGENT_NAMES = Object.keys(AGENTS);

/** Parse an --agent value: "claude" (default) | "codex" | "gemini" | "cursor" | "all" | comma list. */
export function resolveAgents(value) {
  const v = (value || "claude").trim().toLowerCase();
  if (v === "all") return AGENT_NAMES.map((n) => AGENTS[n]);
  const out = [];
  for (const part of v.split(",")) {
    const name = part.trim();
    if (!name) continue;
    if (!AGENTS[name]) throw new Error(`Unknown --agent "${name}". Use one of: ${[...AGENT_NAMES, "all"].join(", ")}`);
    if (!out.includes(AGENTS[name])) out.push(AGENTS[name]);
  }
  return out.length ? out : [claude];
}

/**
 * Locate log files for the chosen agents. `dirs` (from --dir / $CCLEDGER_DIR) applies when a single
 * agent is selected; with several agents each one uses its default location.
 * Returns { sources: [{agent, entries}], notes: [string] }.
 */
export function locate(agents, dirs) {
  const sources = [];
  const notes = [];
  for (const a of agents) {
    const reason = a.unavailable?.();
    if (reason) {
      notes.push(`${a.label}: ${reason}`);
      continue;
    }
    const useDirs = dirs?.length && agents.length === 1 ? dirs : a.defaultDirs();
    const entries = a.listFiles(useDirs);
    sources.push({ agent: a, dirs: useDirs, entries });
  }
  return { sources, notes };
}

/** Async iterable over the normalized turns of every located source, in order. */
export async function* readAll(sources) {
  for (const s of sources) yield* s.agent.read(s.entries);
}
