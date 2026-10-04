import type { Context, MiddlewareHandler } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { isIP } from 'node:net';
import type { Store } from '../store/types.js';
import { MemoryStore } from '../store/memory.js';

const normalize = (ip: string) => ip.startsWith('::ffff:') ? ip.slice(7) : ip;
export function clientIp(c: Context): string {
  let peer = 'unknown';
  try { peer = normalize(getConnInfo(c).remote.address ?? 'unknown'); } catch { /* no socket in in-process tests */ }
  const trusted = (process.env.TRUSTED_PROXY_IPS ?? '').split(',').map(ip => normalize(ip.trim())).filter(Boolean);
  if (!trusted.includes(peer)) return peer;
  // The configured proxy must overwrite this header, never append client-supplied values.
  const header = process.env.TRUSTED_PROXY_HEADER ?? 'x-forwarded-for';
  if (header !== 'x-forwarded-for' && header !== 'cf-connecting-ip') return peer;
  const forwarded = c.req.header(header)?.trim();
  return forwarded && isIP(forwarded) ? normalize(forwarded) : peer;
}
interface Opts { windowMs: number; max: number; key?: string; store?: Store }
export function rateLimit({ windowMs, max, key = 'default', store = new MemoryStore() }: Opts): MiddlewareHandler {
  return async (c, next) => {
    const result = await store.consumeRateLimit(`${key}:${clientIp(c)}`, windowMs, max);
    if (!result.allowed) {
      c.header('Retry-After', String(result.retryAfter));
      return c.json({ error: `Too many requests. Try again in ${result.retryAfter} seconds.` }, 429);
    }
    await next();
  };
}
