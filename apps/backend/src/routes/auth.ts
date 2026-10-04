import { Hono } from "hono";
import { z } from "zod";
import { GoogleAuthError, verifyGoogleIdToken } from "../auth/google.js";
import { requireUser, signSession, signVoiceToken, type AuthEnv } from "../auth/session.js";
import { rateLimit } from "../security/rateLimit.js";
import { mergedUser } from "./profile.js";
import type { Deps } from "../services/orders.js";

const googleBody = z.object({ credential: z.string().min(1).max(4096) });

export function authRoutes(deps: Deps) {
  const app = new Hono<AuthEnv>();
  const verify = deps.verifyGoogle ?? verifyGoogleIdToken;

  app.post("/google", rateLimit({ windowMs: 60_000, max: 10, key: "auth-google" }), async (c) => {
    const { credential } = googleBody.parse(await c.req.json());
    try {
      const user = await verify(credential);
      const u = { email: user.email.toLowerCase(), name: user.name, picture: user.picture };
      return c.json({ token: await signSession(u), user: await mergedUser(deps.store, u) });
    } catch (e) {
      if (e instanceof GoogleAuthError && e.notConfigured) return c.json({ error: "google_not_configured" }, 503);
      return c.json({ error: "invalid_google_token" }, 401);
    }
  });

  app.get("/me", requireUser, async (c) => c.json({ user: await mergedUser(deps.store, c.get("user")) }));

  app.post("/voice-token", requireUser, async (c) => c.json({ token: await signVoiceToken(c.get("user").email) }));

  return app;
}
