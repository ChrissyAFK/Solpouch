import { Hono } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import { ZodError } from "zod";
import type { ApiError } from "@solpouch/shared";
import { HttpError, type Deps } from "./services/orders.js";
import { merchantRoutes } from "./routes/merchants.js";
import { orderRoutes } from "./routes/orders.js";
import { pouchRoutes } from "./routes/pouches.js";
import { statsRoutes } from "./routes/stats.js";
import { topupRoutes } from "./routes/topups.js";
import { voiceRoutes } from "./routes/voice.js";
import { chatRoutes } from "./routes/chat.js";
import { profileRoutes } from "./routes/profile.js";
import { authRoutes } from "./routes/auth.js";
import { verifySession } from "./auth/session.js";
import { requireVoiceSecret, voiceEmail } from "./security/auth.js";
import { ownedStore } from "./security/access.js";
import { StoreConflictError } from "./store/types.js";
import { rateLimit } from "./security/rateLimit.js";

const DEFAULT_ORIGINS = ["http://localhost:3000", "https://solpouch.tech", "https://www.solpouch.tech"];
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

export function createApp(deps: Deps) {
  const app = new Hono();
  const origins = process.env.WEB_ORIGINS
    ? process.env.WEB_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean)
    : DEFAULT_ORIGINS;

  app.use("*", secureHeaders());
  app.use("*", async (c, next) => { c.header("Cache-Control", "no-store"); await next(); });
  app.use("*", bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ error: "Request body too large" } satisfies ApiError, 413) }));
  app.use(
    "*",
    cors({
      origin: (o) => (origins.includes(o) ? o : null),
      allowHeaders: ["Content-Type", "X-Solpouch-Secret", "Authorization"],
    }),
  );
  // No cookies: auth is a Bearer token, so there is no CSRF surface.

  const writes = rateLimit({ store: deps.store, windowMs: MIN, max: 30, key: "write" });
  const gemini = rateLimit({ store: deps.store, windowMs: MIN, max: 10, key: "gemini-min" });
  const geminiDay = rateLimit({ store: deps.store, windowMs: DAY, max: 200, key: "gemini-day" });
  const topups = rateLimit({ store: deps.store, windowMs: MIN, max: 5, key: "topup" });
  app.use("*", rateLimit({ store: deps.store, windowMs: MIN, max: 120, key: "all" }));
  app.use("*", async (c, next) => {
    const m = c.req.method;
    return m === "POST" || m === "PATCH" ? writes(c, next) : next();
  });
  app.on("POST", ["/chat", "/orders", "/voice/tools/create_order"], gemini, geminiDay);
  app.on("POST", "/topups/*", topups);
  app.use("/voice/*", rateLimit({ store: deps.store, windowMs: MIN, max: 60, key: "voice" }));

  app.use("/auth/*", rateLimit({ store: deps.store, windowMs: MIN, max: 20, key: "auth" }));
  app.route("/auth", authRoutes(deps, origins));
  app.get("/health", (c) => c.json({ ok: true, mode: process.env.VAULT_MODE === "chain" ? "chain" : "mock", network: process.env.VAULT_MODE === "chain" ? "devnet" : "simulated" }));
  app.use("*", async (c, next) => {
    const path = c.req.path;
    // Public: health, merchant catalog, chat mode. /auth/* routes authenticate themselves.
    if (path === "/health" || path === "/merchants" || path.startsWith("/merchants/") || path.startsWith("/auth/") || (c.req.method === "GET" && path === "/chat/status")) return next();
    let email: string | undefined;
    if (path === "/voice" || path.startsWith("/voice/")) {
      requireVoiceSecret(c);
      email = await voiceEmail(c);
    } else {
      const m = /^Bearer (.+)$/.exec(c.req.header("authorization") ?? "");
      email = m ? (await verifySession(m[1]!))?.email : undefined;
    }
    if (!email) return c.json({ error: "sign_in_required" } satisfies ApiError, 401);
    c.set("email", email);
    c.set("deps", { ...deps, store: ownedStore(deps.store, email) });
    await next();
  });
  app.route("/profile", profileRoutes(deps));
  app.route("/pouches", pouchRoutes(deps));
  app.route("/orders", orderRoutes(deps));
  app.route("/topups", topupRoutes(deps));
  app.route("/merchants", merchantRoutes());
  app.route("/stats", statsRoutes(deps));
  app.route("/voice", voiceRoutes(deps));
  app.route("/chat", chatRoutes(deps));

  app.onError((err, c) => {
    if (err instanceof StoreConflictError) return c.json({ error: 'This record changed. Reload and try again.', code: 'RecordChanged' }, 409);
    if (err instanceof HttpError) {
      const body: ApiError = { error: err.message, code: err.code };
      return c.json(body, err.status);
    }
    if (err instanceof ZodError) {
      const body: ApiError = { error: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
      return c.json(body, 400);
    }
    if (err instanceof SyntaxError) return c.json({ error: "Invalid JSON body" } satisfies ApiError, 400);
    console.error(err);
    return c.json({ error: "Internal error" } satisfies ApiError, 500);
  });
  return app;
}
