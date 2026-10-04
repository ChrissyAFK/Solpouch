import { createPublicKey, timingSafeEqual, verify } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import type { Context } from 'hono';
import { verifyVoiceToken } from '../auth/session.js';
import { HttpError } from '../services/orders.js';
import { clientIp } from './rateLimit.js';

export function validWallet(wallet: string): boolean {
  try { const key = new PublicKey(wallet); return key.toBase58() === wallet && PublicKey.isOnCurve(key.toBytes()); } catch { return false; }
}
export function validSignature(wallet: string, message: string, signature: string): boolean {
  try {
    if (!/^[A-Za-z0-9+/]{86}==$/.test(signature)) return false;
    const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), new PublicKey(wallet).toBuffer()]), format: 'der', type: 'spki' });
    return verify(null, Buffer.from(message), key, Buffer.from(signature, 'base64'));
  } catch { return false; }
}
const VOICE_MAX_FAILS = 10;
const VOICE_LOCK_MS = 10 * 60_000;
const voiceFails = new Map<string, { count: number; until: number }>();
/** Test helper: forget all recorded voice secret failures. */
export function resetVoiceLockouts() { voiceFails.clear(); }
export function requireVoiceSecret(c: Context) {
  const expected = process.env.VOICE_WEBHOOK_SECRET || process.env.ELEVENLABS_TOOL_SECRET;
  const provided = c.req.header('X-Solpouch-Secret') ?? '';
  if (!expected) throw new HttpError(503, 'Voice tools are not configured');
  const ip = clientIp(c), now = Date.now();
  const rec = voiceFails.get(ip);
  if (rec && rec.until > now) throw new HttpError(429, 'Too many failed voice requests. Try again later.');
  if (rec && rec.until && rec.until <= now) voiceFails.delete(ip);
  const a = Buffer.from(expected), b = Buffer.from(provided);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    const cur = voiceFails.get(ip) ?? { count: 0, until: 0 };
    cur.count += 1;
    if (cur.count >= VOICE_MAX_FAILS) cur.until = now + VOICE_LOCK_MS;
    voiceFails.set(ip, cur);
    if (voiceFails.size > 10_000) for (const [k, v] of voiceFails) if (v.until && v.until <= now) voiceFails.delete(k);
    throw new HttpError(401, 'Unauthorized voice request');
  }
  voiceFails.delete(ip);
}
/**
 * Email of the user a voice tool call acts for: the voice JWT from `Authorization: Bearer`,
 * falling back to a `user_token` field in a JSON body. Undefined when absent or invalid.
 */
export async function voiceEmail(c: Context): Promise<string | undefined> {
  const m = /^Bearer (.+)$/.exec(c.req.header('authorization') ?? '');
  if (m) return verifyVoiceToken(m[1]);
  if (c.req.method === 'GET' || c.req.method === 'HEAD') return undefined;
  try {
    const body = await c.req.json() as { user_token?: unknown } | null; // Hono caches the parsed body
    return verifyVoiceToken(body?.user_token);
  } catch { return undefined; }
}
