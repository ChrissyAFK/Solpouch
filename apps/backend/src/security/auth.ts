import { createPublicKey, verify } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import type { Context } from 'hono';
import type { Store } from "../store/types.js";
import { verifyVoiceToken } from '../auth/session.js';

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
/**
 * Email of the user a voice tool call acts for: the voice JWT from `Authorization: Bearer`,
 * falling back to a `user_token` field in a JSON body. Undefined when absent or invalid.
 */
export async function voiceEmail(c: Context, store: Store): Promise<string | undefined> {
  const m = /^Bearer (.+)$/.exec(c.req.header('authorization') ?? '');
  if (m) return verifyVoiceToken(m[1], store);
  if (c.req.method === 'GET' || c.req.method === 'HEAD') return undefined;
  try {
    const body = await c.req.json() as { user_token?: unknown } | null; // Hono caches the parsed body
    return verifyVoiceToken(body?.user_token, store);
  } catch { return undefined; }
}
