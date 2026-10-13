/* User config (~/.config/ccledger/config.json) and ledger state (markers) — tiny, dependency-free. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function configDir() {
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "ccledger");
}
export function configPath() {
  return path.join(configDir(), "config.json");
}
export function statePath() {
  return path.join(configDir(), "state.json");
}

function readJson(file, fallback) {
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    return j && typeof j === "object" ? j : fallback;
  } catch {
    return fallback;
  }
}

/** Keys: budget (USD per day), agent (default --agent), large, top. Unknown keys are ignored. */
export function loadConfig() {
  return readJson(configPath(), {});
}

export function loadState() {
  const s = readJson(statePath(), {});
  if (!Array.isArray(s.markers)) s.markers = [];
  return s;
}

export function saveState(state) {
  fs.mkdirSync(configDir(), { recursive: true });
  const tmp = statePath() + `.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  fs.renameSync(tmp, statePath());
  return statePath();
}

/** Append a marker {label, ts} and return it. */
export function addMarker(label, ts = Date.now()) {
  const state = loadState();
  const m = { label: String(label || "").trim() || "marker", ts };
  state.markers.push(m);
  saveState(state);
  return m;
}

/** Latest marker, or the latest whose label contains `label` (case-insensitive). */
export function findMarker(label) {
  const { markers } = loadState();
  const list = label ? markers.filter((m) => m.label.toLowerCase().includes(String(label).toLowerCase())) : markers;
  return list.length ? list[list.length - 1] : null;
}
