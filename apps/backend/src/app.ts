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
import { authRoutes } from './routes/auth.js';
import { bearer, session, requireVoiceSecret } from './security/auth.js';
import { ownedStore } from './security/access.js';
import { StoreConflictError } from './store/types.js';
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
      credentials: true,
    }),
  );

  // Browser mutations must originate from an explicitly configured site.
  app.use("*", async (c, next) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
      const origin = c.req.header("origin");
      if (origin ? !origins.includes(origin) : !bearer(c)) return c.json({ error: "Request origin is not allowed" }, 403);
    }
    await next();
  });

  const writes = rateLimit({ store: deps.store, windowMs: MIN, max: 30, key: "write" });
  const gemini = rateLimit({ store: deps.store, windowMs: MIN, max: 10, key: "gemini-min" });
  const geminiDay = rateLimit({ store: deps.store, windowMs: DAY, max: 200, key: "gemini-day" });
  const topups = rateLimit({ store: deps.store, windowMs: MIN, max: 5, key: "topup" });
  app.use("*", rateLimit({ store: deps.store, windowMs: MIN, max: 120, key: "all" }));
  app.use("*", async (c, next) => {
    const m = c.req.method;
    return m === "POST" || m === "PATCH" ? writes(c, next) : next();
  });
  app.on("POST", ["/chat", "/orders"], gemini, geminiDay);
  app.on("POST", "/topups/*", topups);
  app.use("/voice/*", rateLimit({ store: deps.store, windowMs: MIN, max: 60, key: "voice" }));

  app.use("/auth/*", rateLimit({ store: deps.store, windowMs: MIN, max: 20, key: "auth" }));
  app.route("/auth", authRoutes(deps, origins));
  app.get("/health", (c) => c.json({ ok: true, mode: process.env.VAULT_MODE === "chain" ? "chain" : "mock", network: process.env.VAULT_MODE === "chain" ? "devnet" : "simulated" }));
  app.use("*", async (c, next) => {
    if (c.req.path === '/health' || c.req.path === '/merchants' || c.req.path.startsWith('/merchants/')) return next();
    const voice = c.req.path === '/voice' || c.req.path.startsWith('/voice/');
    if (voice) requireVoiceSecret(c);
    const current = await session(c, deps.store, voice ? 'voice' : 'web');
    if (process.env.VAULT_MODE === 'chain' && current.wallet !== deps.vault.authorizedOwner) throw new HttpError(403, 'This devnet demo supports only its configured owner wallet');
    c.set('wallet', current.wallet);
    c.set('deps', { ...deps, store: ownedStore(deps.store, current.wallet) });
    c.header('Cache-Control', 'no-store');
    await next();
  });
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
