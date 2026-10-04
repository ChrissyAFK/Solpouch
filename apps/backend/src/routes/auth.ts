import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { GoogleAuthError, verifyGoogleIdToken } from "../auth/google.js";
import { AuthUnavailableError, requireUser, signSession, signVoiceToken, type AuthEnv } from "../auth/session.js";
import { privyJwks, signPrivyToken } from "../auth/privy.js";
import { rateLimit } from "../security/rateLimit.js";
import { validSignature, validWallet } from "../security/wallet.js";
import { StoreConflictError, WalletAlreadyLinkedError } from "../store/types.js";
import { mergedUser } from "./profile.js";
import { HttpError, type Deps } from "../services/orders.js";
import { reconcilePouch } from "../services/reconcile.js";
const googleBody = z.object({ credential: z.string().min(1).max(4096) });
const challengeBody = z.object({ wallet: z.string().max(44).refine(validWallet, "Invalid wallet address") }).strict();
const verifyBody = z.object({ id: z.string().regex(/^[a-f0-9]{48}$/), signature: z.string().max(100) }).strict();
const CHALLENGE_MS = 5 * 60_000;
export function authRoutes(deps: Deps, origins: string[] = []) {
  const app = new Hono<AuthEnv>();
  const verify = deps.verifyGoogle ?? verifyGoogleIdToken;
  const auth = requireUser(deps.store);
  app.post("/google", rateLimit({ store: deps.store, windowMs: 60000, max: 10, key: "auth-google" }), async c => {
    const { credential } = googleBody.parse(await c.req.json());
    let user;
    try { user = await verify(credential); }
    catch (e) {
      if (e instanceof GoogleAuthError && e.notConfigured) return c.json({ error: "google_not_configured" }, 503);
      if (e instanceof AuthUnavailableError) throw e;
      return c.json({ error: "invalid_google_token" }, 401);
    }
    const u = { email: user.email.toLowerCase(), name: user.name, picture: user.picture };
    try {
      const profile = await mergedUser(deps.store, u);
      const { token, session } = await signSession(u, deps.store);
      return c.json({ token, user: profile, expiresAt: session.expiresAt });
    } catch { throw new AuthUnavailableError("Sign-in is temporarily unavailable. Try again shortly"); }
  });
  app.get("/me", auth, async c => c.json({ user: await mergedUser(deps.store, c.get("user")), expiresAt: c.get("session").expiresAt }));
  // Privy custom auth: a short-lived ES256 token plus a public JWKS Privy fetches server to server (no Origin, no auth).
  app.get("/privy-token", rateLimit({ store: deps.store, windowMs: 60000, max: 20, key: "auth-privy-token" }), auth, async c => c.json(await signPrivyToken(c.get("user").email)));
  app.get("/privy-jwks", async c => {
    const jwks = await privyJwks();
    c.header("Cache-Control", "public, max-age=300");
    return c.json(jwks);
  });
  app.post("/voice-token", auth, async c => c.json(await signVoiceToken(c.get("session"))));
  app.post("/logout", auth, async c => { await deps.store.deleteSession(c.get("session").id); return c.json({ ok:true }); });
  app.post("/logout-all", auth, async c => { await deps.store.deleteSessions(c.get("user").email); return c.json({ ok:true }); });
  app.get("/sessions", auth, async c => {
    const sessions = await deps.store.listSessions(c.get("user").email);
    return c.json({ sessions: sessions.filter(s => Date.parse(s.expiresAt)>Date.now()).map(s => ({ id:s.id, createdAt:s.createdAt, expiresAt:s.expiresAt, current:s.id===c.get("session").id })) });
  });
  app.delete("/sessions/:id", auth, async c => {
    const target = await deps.store.getSession(c.req.param("id"));
    if (!target || target.email !== c.get("user").email) return c.json({error:"Session not found"},404);
    await deps.store.deleteSession(target.id);
    return c.json({ok:true});
  });
  app.use("/wallet/*", auth, async (c, next) => deps.store.withPouchLock(`user:${c.get("user").email}`, next));
  app.use("/wallet", auth, async (c, next) => deps.store.withPouchLock(`user:${c.get("user").email}`, next));
  // Delete my account. Refuses while money or work is in flight; chain pouch accounts stay on chain (empty), no chain calls here.
  app.use("/account", auth, async (c, next) => deps.store.withPouchLock(`user:${c.get("user").email}`, next));
  app.delete("/account", rateLimit({ store: deps.store, windowMs: 60000, max: 3, key: "auth-delete-account" }), auth, async c => {
    const email = c.get("user").email;
    const ids = (await deps.store.listPouches(email)).map(p => p.id).sort();
    // Every pouch lock is held (in id order) from the checks to the delete, so no payment or withdrawal can start in between.
    const locked = (i: number, fn: () => Promise<Response>): Promise<Response> => i < ids.length ? deps.store.withPouchLock(ids[i]!, () => locked(i + 1, fn)) : fn();
    return locked(0, async () => {
      const blockers: string[] = [];
      for (const id of ids) {
        // The stored balance is a mirror: read the chain first, and refuse (503) when it cannot be read.
        const p = await reconcilePouch(deps, id);
        if (p.balance > 0) blockers.push(`${p.name} still holds money. Withdraw or spend the remaining balance first`);
        if ((await deps.store.listWithdrawals(id)).some(w => w.status === "holding" || w.status === "processing")) blockers.push(`${p.name} has a withdrawal in progress`);
        if ((await deps.store.listTopUps(id)).some(t => t.status === "cooling_down" || t.status === "processing")) blockers.push(`${p.name} has a top-up in progress`);
        if ((await deps.store.listOrders(id)).some(o => o.status === "paying")) blockers.push(`${p.name} has a payment in progress`);
      }
      if (blockers.length) return c.json({ error: "Your account can't be deleted yet. Empty your pouches and let anything in progress finish first.", code: "AccountNotEmpty", blockers }, 409);
      await deps.store.deleteAccount(email);
      // After the account is gone, so a failed delete never leaves it half removed.
      await deps.fundingRepository?.deleteOwner(email);
      return c.json({ ok: true });
    });
  });
  const voiceConfigured = () => Boolean(process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_AGENT_ID && (process.env.VOICE_WEBHOOK_SECRET || process.env.ELEVENLABS_TOOL_SECRET) && process.env.ELEVENLABS_SECURE_TOOLS_CONFIGURED === "true");
  app.get("/voice-status", auth, (c) => c.json({ enabled: voiceConfigured() }));
  app.post("/voice-session", auth, async (c) => {
    if (!voiceConfigured()) throw new HttpError(503, "Voice is not configured. You can still use the text helper");
    let signedUrl: string;
    try {
      const url = new URL("https://api.elevenlabs.io/v1/convai/conversation/get-signed-url");
      url.searchParams.set("agent_id", process.env.ELEVENLABS_AGENT_ID!);
      const response = await fetch(url, { headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY! }, signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error("Provider unavailable");
      const data = await response.json() as { signed_url?: unknown };
      if (typeof data.signed_url !== "string") throw new Error("Missing URL");
      const parsed = new URL(data.signed_url);
      if (parsed.protocol !== "wss:" || parsed.hostname !== "api.elevenlabs.io" || parsed.pathname !== "/v1/convai/conversation" || (parsed.port && parsed.port !== "443") || parsed.username || parsed.password) throw new Error("Invalid URL");
      signedUrl = parsed.href;
    } catch {
      throw new HttpError(503, "Voice could not connect. Try again or use the text helper");
    }
    return c.json({ signedUrl, ...(await signVoiceToken(c.get("session"))) });
  });
  // Link a Solana wallet to the signed-in account by signing a challenge. Proves ownership; moves no money.
  const walletLimit = rateLimit({ store: deps.store, windowMs: 60000, max: 20, key: "auth-wallet" });
  const allowedOrigin = (origin: string | undefined) => !!origin && origins.includes(origin);
  app.post("/wallet/challenge", walletLimit, auth, async c => {
    const { wallet } = challengeBody.parse(await c.req.json());
    const origin = c.req.header("origin");
    if (!allowedOrigin(origin)) throw new HttpError(403, "Open Solpouch on an allowed website to link a wallet");
    const session = c.get("session");
    const linked = (await deps.store.getUser(session.email))?.wallet;
    if (linked && linked !== wallet) throw new HttpError(409, "Unlink your current wallet before linking another");
    const holder = await deps.store.findUserByWallet(wallet);
    if (holder && holder.email !== session.email) throw new HttpError(409, "This wallet is linked to another account");
    const id = randomBytes(24).toString("hex");
    const now = new Date();
    const expiresAt = new Date(Math.min(now.getTime() + CHALLENGE_MS, Date.parse(session.expiresAt))).toISOString();
    const message = `${new URL(origin!).host} wants to link this wallet to your Solpouch account (${session.email}).\n\nWallet: ${wallet}\nURI: ${origin}\nNonce: ${id}\nIssued At: ${now.toISOString()}\nExpiration Time: ${expiresAt}\n\nThis proves you own the wallet. It does not approve a transaction.`;
    await deps.store.saveChallenge({ id, wallet, email: session.email, sessionId: session.id, origin: origin!, message, expiresAt });
    return c.json({ id, message, expiresAt });
  });
  app.post("/wallet/verify", walletLimit, auth, async c => {
    const { id, signature } = verifyBody.parse(await c.req.json());
    const session = c.get("session");
    const origin = c.req.header("origin");
    const challenge = await deps.store.consumeChallenge(id); // single use, even when it fails below
    if (!challenge || Date.parse(challenge.expiresAt) <= Date.now() || challenge.email !== session.email || challenge.sessionId !== session.id
      || !allowedOrigin(origin) || challenge.origin !== origin || !validSignature(challenge.wallet, challenge.message, signature)) {
      throw new HttpError(400, "Signature is invalid or expired. Try linking again", "WalletProofInvalid");
    }
    const linked = (await deps.store.getUser(session.email))?.wallet;
    if (linked && linked !== challenge.wallet) throw new HttpError(409, "Unlink your current wallet before linking another");
    try { await deps.store.setWallet(session.email, challenge.wallet); }
    catch (e) {
      if (e instanceof WalletAlreadyLinkedError) throw new HttpError(409, "Unlink your current wallet before linking another");
      if (e instanceof StoreConflictError) throw new HttpError(409, "This wallet is linked to another account");
      throw e;
    }
    return c.json({ user: await mergedUser(deps.store, c.get("user")) });
  });
  app.delete("/wallet", auth, async c => {
    await deps.store.setWallet(c.get("user").email, null);
    return c.json({ user: await mergedUser(deps.store, c.get("user")) });
  });
  return app;
}
