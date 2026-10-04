import { randomBytes } from 'node:crypto';
import { getCookie } from 'hono/cookie';
import { Hono } from 'hono';
import { z } from 'zod';
import { HttpError, type Deps } from '../services/orders.js';
import { bearer, COOKIE, hashToken, clearCookie, issueSession, session, validSignature, validWallet, writeCookie } from '../security/auth.js';

export function authRoutes(deps: Deps, origins: string[]) {
  const app = new Hono();
  app.use('*', async (c, next) => { c.header('Cache-Control', 'no-store'); await next(); });
  app.post('/challenge', async c => {
    const { wallet } = z.object({ wallet: z.string().max(44).refine(validWallet, 'Invalid wallet address') }).strict().parse(await c.req.json());
    const origin = c.req.header('origin');
    if (!origin || !origins.includes(origin)) throw new HttpError(403, 'Open Solpouch on an allowed website to sign in');
    const id = randomBytes(24).toString('hex');
    const now = new Date(); const expiresAt = new Date(now.getTime() + 5 * 60_000).toISOString();
    const message = `${new URL(origin).host} wants you to sign in to Solpouch.\n\nWallet: ${wallet}\nURI: ${origin}\nNonce: ${id}\nIssued At: ${now.toISOString()}\nExpiration Time: ${expiresAt}\n\nThis proves wallet ownership. It does not approve a transaction.`;
    await deps.store.saveChallenge({ id, wallet, message, expiresAt });
    return c.json({ id, message });
  });
  app.post('/verify', async c => {
    const { id, signature } = z.object({ id: z.string().regex(/^[a-f0-9]{48}$/), signature: z.string().max(100) }).strict().parse(await c.req.json());
    const challenge = await deps.store.consumeChallenge(id);
    const origin = c.req.header('origin');
    if (!challenge || Date.parse(challenge.expiresAt) <= Date.now() || !origin || !origins.includes(origin) || !challenge.message.includes(`\nURI: ${origin}\n`) || !validSignature(challenge.wallet, challenge.message, signature)) throw new HttpError(401, 'Signature is invalid or expired. Try signing in again');
    if (process.env.VAULT_MODE === 'chain' && deps.vault.authorizedOwner !== challenge.wallet) throw new HttpError(403, 'This devnet demo supports only its configured owner wallet');
    const issued = await issueSession(deps.store, challenge.wallet);
    writeCookie(c, issued.token);
    return c.json({ wallet: challenge.wallet });
  });
  app.get('/session', async c => c.json({ wallet: (await session(c, deps.store)).wallet }));
  app.post('/logout', async c => { const token = bearer(c) ?? getCookie(c, COOKIE); if (token) await deps.store.deleteSession(hashToken(token)); clearCookie(c); return c.json({ ok: true }); });
  app.post('/voice-token', async c => {
    const current = await session(c, deps.store);
    if (!process.env.VOICE_WEBHOOK_SECRET) throw new HttpError(503, 'Voice tools are not configured');
    return c.json(await issueSession(deps.store, current.wallet, 'voice', current.tokenHash));
  });
  return app;
}
