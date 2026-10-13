/* Daily budget formatting shared by the statusline and `ccledger today`. Pure functions. */
import { fmtUsd, c } from "./render.js";

export const BUDGET_WARN = 0.8;
export const BUDGET_ALERT = 1.0;

/** Parse a --budget / config value; returns a positive number or null. */
export function parseBudget(v) {
  if (v == null || v === "") return null;
  const n = Number(String(v).replace(/^\$/, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** "ok" | "warn" (≥80%) | "alert" (≥100%), or null without a budget. */
export function budgetLevel(spent, budget) {
  if (!budget) return null;
  const r = spent / budget;
  return r >= BUDGET_ALERT ? "alert" : r >= BUDGET_WARN ? "warn" : "ok";
}

/**
 * One segment such as `today $12.40/$20 62%`. Warning level is yellow and suffixed "⚠",
 * alert level is red and suffixed "⚠ over". Colors go through render.js, so NO_COLOR /
 * --no-color / non-TTY output stays plain and the suffix still carries the state.
 */
export function formatBudget(spent, budget, { prefix = "today " } = {}) {
  if (!budget) return null;
  const level = budgetLevel(spent, budget);
  const pct = Math.round((spent / budget) * 100);
  const text = `${prefix}${fmtUsd(spent)}/${Number.isInteger(budget) ? "$" + budget : fmtUsd(budget)} ${pct}%` + (level === "alert" ? " ⚠ over" : level === "warn" ? " ⚠" : "");
  return level === "alert" ? c.red(text) : level === "warn" ? c.yellow(text) : text;
}
