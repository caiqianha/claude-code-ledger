import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export const BUNDLED_PRICING = path.join(here, "..", "pricing.json");
export const PRICING_URL = "https://raw.githubusercontent.com/caiqianha/claude-code-ledger/main/pricing.json";

/** Per-user override, written by `ccledger update-pricing` and `ccledger calibrate --write`. */
export function userPricingPath() {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "ccledger", "pricing.json");
}

/** Resolution order: explicit file > user override > bundled. Returns { models, source }. */
export function loadPricing(file) {
  const candidates = [file, userPricingPath(), BUNDLED_PRICING].filter(Boolean);
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    const json = JSON.parse(fs.readFileSync(p, "utf8"));
    const models = json.models || json;
    Object.defineProperty(models, "_source", { value: p, enumerable: false });
    return models;
  }
  throw new Error("No pricing file found");
}

const cache = new Map();

/** Resolve a price entry for a model id: exact, date-suffix stripped, then longest prefix. */
export function resolvePrice(pricing, model) {
  if (!model) return null;
  const ck = pricing._source + "\u0000" + model;
  if (cache.has(ck)) return cache.get(ck);
  let hit = pricing[model] || null;
  if (!hit) {
    const bare = model.replace(/-\d{8}$/, "").replace(/-latest$/, "");
    hit = pricing[bare] || null;
  }
  if (!hit) {
    let best = "";
    for (const k of Object.keys(pricing)) {
      if (k.startsWith("_")) continue;
      if (model.startsWith(k) && k.length > best.length) best = k;
    }
    hit = best ? pricing[best] : null;
  }
  cache.set(ck, hit);
  return hit;
}

/** USD for a normalized usage object. Returns null when the model is unknown. */
export function costOf(usage, price) {
  if (!price) return null;
  const M = 1e6;
  return (
    (usage.input / M) * price.input +
    (usage.output / M) * price.output +
    (usage.cacheRead / M) * (price.cache_read ?? price.input * 0.1) +
    (usage.cacheWrite5m / M) * (price.cache_write_5m ?? price.input * 1.25) +
    (usage.cacheWrite1h / M) * (price.cache_write_1h ?? price.input * 2)
  );
}

/** Download the latest bundled pricing table into the user override path. */
export async function updatePricing(url = PRICING_URL) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch pricing: HTTP ${res.status}`);
  const text = await res.text();
  JSON.parse(text); // validate
  const dest = userPricingPath();
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, text);
  return dest;
}

/** Write a scaled copy of `pricing` (per-model multipliers) into the user override path. */
export function writeCalibrated(pricing, multipliers) {
  const out = { _comment: `Calibrated by ccledger on ${new Date().toISOString().slice(0, 10)} from Claude Code cost-state records. Delete this file to return to list prices.`, models: {} };
  for (const [k, v] of Object.entries(pricing)) {
    if (k.startsWith("_")) continue;
    const m = multipliers[k];
    out.models[k] = m ? Object.fromEntries(Object.entries(v).map(([f, n]) => [f, typeof n === "number" ? +(n * m).toFixed(4) : n])) : v;
    if (m) out.models[k]._calibration = +m.toFixed(3);
  }
  const dest = userPricingPath();
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, JSON.stringify(out, null, 2) + "\n");
  return dest;
}
