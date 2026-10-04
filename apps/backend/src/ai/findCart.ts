import type { ParsedItem } from "./gemini.js";
import { findOnline, normalizeDomain, type WebFind } from "./findOnline.js";
import { verifyPrice } from "./verifyPrice.js";

export type FindOpts = NonNullable<Parameters<typeof findOnline>[1]>;
interface FindDeps { find?: typeof findOnline; verify?: typeof verifyPrice; now?: () => number }

const HOUR = 3600_000;
const MAX_ENTRIES = 500;
const cache = new Map<string, { at: number; ttl: number; find: WebFind }>();
export function clearFindCache() { cache.clear(); }

const norm = (s?: string) => (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
function cacheKey(items: ParsedItem[], o: FindOpts): string {
  return JSON.stringify([
    items.map((i) => norm(i.requested)).sort(),
    norm(o.store), norm(o.service), norm(o.region), o.maxTotal ?? null, o.maxPerItem ?? null, !!o.chooseItems,
    (o.allowedDomains ?? []).map(normalizeDomain).sort(),
  ]);
}
const copy = (f: WebFind): WebFind => ({ ...f, store: { ...f.store }, items: f.items.map((i) => ({ ...i })) });

/** Search for the items, then confirm each price against its product page. Repeats come from a short-lived cache. */
export async function findCart(items: ParsedItem[], opts: FindOpts = {}, deps: FindDeps = {}): Promise<WebFind | null> {
  const now = deps.now ?? Date.now;
  const key = cacheKey(items, opts);
  const hit = cache.get(key);
  if (hit && now() - hit.at < hit.ttl) return copy(hit.find);
  cache.delete(key);

  const found = await (deps.find ?? findOnline)(items, opts);
  if (!found || found.fallback) return found;

  const verify = deps.verify ?? verifyPrice;
  const checks = process.env.VERIFY_PRICES === "0"
    ? found.items.map(() => ({ status: "estimate" as const, reason: "checks off" }))
    : await Promise.all(found.items.map((i) => verify(i, found.store.domain).catch(() => ({ status: "estimate" as const, reason: "check failed" }))));
  const out: WebFind = {
    ...found,
    items: found.items.map((i, n) => {
      const c = checks[n];
      return c.status === "verified" ? { ...i, unitPrice: c.unitPrice, verified: true } : { ...i, verified: false };
    }),
  };
  if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value!);
  cache.set(key, { at: now(), ttl: out.items.every((i) => i.verified) ? 24 * HOUR : HOUR, find: copy(out) });
  return out;
}
