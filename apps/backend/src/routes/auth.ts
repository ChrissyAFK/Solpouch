import { Hono } from "hono";
import { z } from "zod";
import { GoogleAuthError, verifyGoogleIdToken } from "../auth/google.js";
import { AuthUnavailableError, requireUser, signSession, signVoiceToken, type AuthEnv } from "../auth/session.js";
import { rateLimit } from "../security/rateLimit.js";
import { mergedUser } from "./profile.js";
import type { Deps } from "../services/orders.js";
const googleBody = z.object({ credential: z.string().min(1).max(4096) });
export function authRoutes(deps: Deps) {
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
  return app;
}
