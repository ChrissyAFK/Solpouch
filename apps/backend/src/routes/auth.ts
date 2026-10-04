import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { GoogleAuthError, verifyGoogleIdToken } from "../auth/google.js";
import { requireUser, signSession, signVoiceToken, type AuthEnv } from "../auth/session.js";
import { rateLimit } from "../security/rateLimit.js";
import { validSignature, validWallet } from "../security/auth.js";
import { StoreConflictError } from "../store/types.js";
import { mergedUser } from "./profile.js";
import { HttpError, type Deps } from "../services/orders.js";

const googleBody = z.object({ credential: z.string().min(1).max(4096) });
const VOICE_TOKEN_MS = 30 * 60_000;

export function authRoutes(deps: Deps, origins: string[]) {
  const app = new Hono<AuthEnv>();
  const verify = deps.verifyGoogle ?? verifyGoogleIdToken;
  app.use("*", async (c, next) => { c.header("Cache-Control", "no-store"); await next(); });

  app.post("/google", rateLimit({ windowMs: 60_000, max: 10, key: "auth-google" }), async (c) => {
    const { credential } = googleBody.parse(await c.req.json());
    try {
      const user = await verify(credential);
      const u = { email: user.email.toLowerCase(), name: user.name, picture: user.picture };
      return c.json({ token: await signSession(u), user: await mergedUser(deps.store, u) });
    } catch (e) {
      if (e instanceof GoogleAuthError && e.notConfigured) return c.json({ error: "Google sign-in is not set up yet. Try again later.", code: "GoogleNotConfigured" }, 503);
      return c.json({ error: "invalid_google_token" }, 401);
    }
  });

  app.get("/me", requireUser, async (c) => c.json({ user: await mergedUser(deps.store, c.get("user")) }));

  app.post("/voice-token", requireUser, async (c) => c.json({ token: await signVoiceToken(c.get("user").email) }));

  // Link a Solana wallet to the signed-in Google account (proof of ownership by signing a message).
  app.post("/wallet/challenge", requireUser, async (c) => {
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

  app.post("/wallet/verify", requireUser, async (c) => {
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

  app.delete("/wallet", requireUser, async (c) => {
    const session = c.get("user");
    const prev = await deps.store.getUser(session.email);
    if (prev?.wallet) {
      await deps.store.updateUser(session.email, { wallet: null }, new Date().toISOString());
    }
    return c.json({ user: await mergedUser(deps.store, session) });
  });

  const voiceConfigured = () => Boolean(process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_AGENT_ID && (process.env.VOICE_WEBHOOK_SECRET || process.env.ELEVENLABS_TOOL_SECRET) && process.env.ELEVENLABS_SECURE_TOOLS_CONFIGURED === "true");
  app.get("/voice-status", requireUser, (c) => c.json({ enabled: voiceConfigured() }));
  app.post("/voice-session", requireUser, async (c) => {
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
    return c.json({ signedUrl, token: await signVoiceToken(c.get("user").email), expiresAt: new Date(Date.now() + VOICE_TOKEN_MS).toISOString() });
  });

  return app;
}
