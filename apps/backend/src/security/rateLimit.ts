import { isIP } from "node:net";
import type { Context, MiddlewareHandler } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { Store } from "../store/types.js";
const normalize = (ip: string) => ip.startsWith("::ffff:") ? ip.slice(7) : ip;
export function clientIp(c: Context): string {
  let remote = "unknown";
  try { remote = normalize(getConnInfo(c).remote.address ?? "unknown"); } catch { /* In-process tests lack sockets. */ }
  const trusted = (process.env.TRUSTED_PROXY_IPS ?? "").split(",").map(s => normalize(s.trim())).filter(s => isIP(s));
  if (!trusted.includes(remote)) return remote;
  const header = process.env.TRUSTED_PROXY_HEADER ?? "x-forwarded-for";
  if (header === "cf-connecting-ip") {
    const ip = (c.req.header(header) ?? "").trim();
    return isIP(ip) ? normalize(ip) : remote;
  }
  if (header !== "x-forwarded-for") return remote;
  const chain = (c.req.header(header) ?? "").split(",").map(s => normalize(s.trim()));
  // Walk from the actual peer toward the client. Ignore attacker-supplied left entries.
  for (let i = chain.length-1; i >= 0; i--) {
    if (!isIP(chain[i]!)) return remote;
    if (!trusted.includes(chain[i]!)) return chain[i]!;
  }
  return remote;
}
export class RateLimitError extends Error {
  constructor(public retryAfterSeconds: number) { super(`Too many requests. Try again in ${retryAfterSeconds} seconds.`); }
}
export class RateLimitUnavailableError extends Error {}
export async function consumeBudget(store: Store, key: string, windowMs: number, max: number) {
  let result;
  try { result = await store.consumeRateLimit(key, windowMs, max); }
  catch { throw new RateLimitUnavailableError("Request protection is temporarily unavailable. Try again shortly"); }
  if (!result.allowed) throw new RateLimitError(result.retryAfterSeconds);
}
export async function consumeAiBudget(store: Store, email: string) {
  await consumeBudget(store, `ai-min:${email}`, 60000, 10);
  await consumeBudget(store, `ai-day:${email}`, 86400000, 200);
}
interface Opts { store: Store; windowMs: number; max: number; key?: string; }
export function rateLimit({store, windowMs, max, key="default"}: Opts): MiddlewareHandler {
  return async (c, next) => { await consumeBudget(store, `${key}:${clientIp(c)}`, windowMs, max); await next(); };
}
