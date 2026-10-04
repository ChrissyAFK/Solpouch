import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { Context } from 'hono';
import type { Store, AuthSession } from '../store/types.js';
import { HttpError } from '../services/orders.js';

export const COOKIE = 'solpouch_session';
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
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
export function bearer(c: Context): string | undefined { return /^Bearer ([A-Za-z0-9_-]{43})$/.exec(c.req.header('authorization') ?? '')?.[1]; }
export async function session(c: Context, store: Store, scope: 'web'|'voice' = 'web'): Promise<AuthSession> {
  const token = scope === 'voice' ? bearer(c) : bearer(c) ?? getCookie(c, COOKIE);
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new HttpError(401, 'Sign in with your wallet to continue');
  const found = await store.getSession(hashToken(token));
  if (!found || Date.parse(found.expiresAt) <= Date.now() || (found.scope ?? 'web') !== scope) throw new HttpError(401, 'Your session expired. Sign in again');
  if (scope === 'voice') {
    const parent = found.parentTokenHash ? await store.getSession(found.parentTokenHash) : undefined;
    if (!parent || (parent.scope ?? 'web') !== 'web' || parent.wallet !== found.wallet || Date.parse(parent.expiresAt) <= Date.now()) throw new HttpError(401, 'Voice session expired. Sign in again');
  }
  return found;
}
export async function issueSession(store: Store, wallet: string, scope: 'web'|'voice' = 'web', parentTokenHash?: string) {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + (scope === 'web' ? 8 * 60 * 60_000 : 5 * 60_000)).toISOString();
  await store.saveSession({ tokenHash: hashToken(token), wallet, expiresAt, scope, ...(parentTokenHash ? { parentTokenHash } : {}) });
  return { token, expiresAt };
}
export function writeCookie(c: Context, token: string) {
  setCookie(c, COOKIE, token, { httpOnly: true, secure: process.env.NODE_ENV === 'production' || (c.req.header('origin') ?? '').startsWith('https://'), sameSite: 'Lax', path: '/', maxAge: 8 * 3600 });
}
export function clearCookie(c: Context) { deleteCookie(c, COOKIE, { path: '/' }); }
export function requireVoiceSecret(c: Context) {
  const expected = process.env.VOICE_WEBHOOK_SECRET;
  const provided = c.req.header('X-Solpouch-Secret') ?? '';
  if (!expected) throw new HttpError(503, 'Voice tools are not configured');
  const a = Buffer.from(expected), b = Buffer.from(provided);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new HttpError(401, 'Unauthorized voice request');
}
