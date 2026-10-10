import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export function loadPricing(file) {
  const p = file || path.join(here, "..", "pricing.json");
  const json = JSON.parse(fs.readFileSync(p, "utf8"));
  return json.models || json;
}

const cache = new Map();

/** Resolve a price entry for a model id: exact, date-suffix stripped, then longest prefix. */
export function resolvePrice(pricing, model) {
  if (!model) return null;
  if (cache.has(model)) return cache.get(model);
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
  cache.set(model, hit);
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
