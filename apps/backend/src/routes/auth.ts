import { randomBytes } from "node:crypto";
import { validSignature, validWallet } from "../security/auth.js";
import { StoreConflictError } from "../store/types.js";
import { Hono } from "hono";
import { z } from "zod";
import { GoogleAuthError, verifyGoogleIdToken } from "../auth/google.js";
import { AuthUnavailableError, requireUser, signSession, signVoiceToken, type AuthEnv } from "../auth/session.js";
import { rateLimit } from "../security/rateLimit.js";
import { mergedUser } from "./profile.js";
import { HttpError, type Deps } from "../services/orders.js";
const googleBody = z.object({ credential: z.string().min(1).max(4096) });
export function authRoutes(deps: Deps, origins: string[]) {
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

  // Link a Solana wallet to the signed-in Google account (proof of ownership by signing a message).
  app.post("/wallet/challenge", auth, async (c) => {
    const { wallet } = z.object({ wallet: z.string().max(44).refine(validWallet, "Invalid wallet address") }).strict().parse(await c.req.json());
    const origin = c.req.header("origin");
    if (!origin || !origins.includes(origin)) throw new HttpError(403, "Open Solpouch on an allowed website to link a wallet");
    const email = c.get("user").email;
    const id = randomBytes(24).toString("hex");
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 5 * 60_000).toISOString();
    const message = `${new URL(origin).host} wants to link this wallet to your Solpouch account (${email}).\n\nWallet: ${wallet}\nURI: ${origin}\nNonce: ${id}\nIssued At: ${now.toISOString()}\nExpiration Time: ${expiresAt}\n\nThis proves you own the wallet. It does not approve a transaction.`;
    await deps.store.saveChallenge({ id, wallet, email, message, expiresAt });
    return c.json({ id, message });
  });

  app.post("/wallet/verify", auth, async (c) => {
    const { id, signature } = z.object({ id: z.string().regex(/^[a-f0-9]{48}$/), signature: z.string().max(100) }).strict().parse(await c.req.json());
    const session = c.get("user");
    const challenge = await deps.store.consumeChallenge(id);
    const origin = c.req.header("origin");
    if (!challenge || Date.parse(challenge.expiresAt) <= Date.now() || !origin || !origins.includes(origin) || !challenge.message.includes(`\nURI: ${origin}\n`) || challenge.email !== session.email || !validSignature(challenge.wallet, challenge.message, signature)) {
      throw new HttpError(401, "Signature is invalid or expired. Try linking again");
    }
    const holder = await deps.store.findUserByWallet(challenge.wallet);
    if (holder && holder.email !== session.email) throw new HttpError(409, "This wallet is linked to another account");
    const now = new Date().toISOString();
    try {
      await deps.store.updateUser(session.email, { wallet: challenge.wallet }, now);
    } catch (e) {
      if (e instanceof StoreConflictError) throw new HttpError(409, "This wallet is linked to another account");
      throw e;
    }
    return c.json({ user: await mergedUser(deps.store, session) });
  });

  app.delete("/wallet", auth, async (c) => {
    const session = c.get("user");
    const prev = await deps.store.getUser(session.email);
    if (prev?.wallet) {
      await deps.store.updateUser(session.email, { wallet: null }, new Date().toISOString());
    }
    return c.json({ user: await mergedUser(deps.store, session) });
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

  return app;
}
