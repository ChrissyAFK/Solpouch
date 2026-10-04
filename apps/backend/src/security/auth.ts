import type { Context } from 'hono';
import type { Store } from "../store/types.js";
import { verifyVoiceToken } from '../auth/session.js';

// One implementation of wallet and signature checks lives in wallet.ts.
export { validWallet, validSignature } from "./wallet.js";
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
