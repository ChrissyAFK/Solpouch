import type { Context, MiddlewareHandler } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";

export function clientIp(c: Context): string {
  const cf = c.req.header("cf-connecting-ip");
  if (cf) return cf.trim();
  const xff = c.req.header("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  try {
    const addr = getConnInfo(c).remote.address;
    if (addr) return addr;
  } catch {
    // no socket (e.g. app.request() in tests)
  }
  return "unknown";
}

interface Opts {
  windowMs: number;
  max: number;
  /** Bucket name, so different limits on the same IP do not share a counter. */
  key?: string;
}

/** In-memory fixed-window limiter. State is per call to rateLimit(), so per app instance. */
export function rateLimit({ windowMs, max, key = "default" }: Opts): MiddlewareHandler {
  const hits = new Map<string, { count: number; resetAt: number }>();
  let lastPrune = Date.now();
  return async (c, next) => {
    const now = Date.now();
    if (now - lastPrune >= 60_000) {
      lastPrune = now;
      for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
    }
    const id = `${key}:${clientIp(c)}`;
    let e = hits.get(id);
    if (!e || e.resetAt <= now) {
      e = { count: 0, resetAt: now + windowMs };
      hits.set(id, e);
    }
    e.count++;
    if (e.count > max) {
      const secs = Math.max(1, Math.ceil((e.resetAt - now) / 1000));
      c.header("Retry-After", String(secs));
      return c.json({ error: `Too many requests. Try again in ${secs} seconds.` }, 429);
    }
    await next();
  };
}
