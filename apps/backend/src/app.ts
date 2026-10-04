import { stripeRoutes, stripeWebhookRoutes } from './routes/stripe.js';
import { shoppingListRoutes } from "./routes/shoppingLists.js";
import { fundingRoutes, fundingWebhookRoutes } from "./routes/funding.js";
import { StoreConflictError } from "./store/types.js";
import { InstacartError } from "./services/instacart.js";
import { OrderInputError } from "./services/orderValidation.js";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import { ZodError } from "zod";
import type { ApiError } from "@solpouch/shared";
import { CheckoutConfigurationError } from "./services/fulfillment.js";
import { VaultRejected } from "./vault/types.js";
import { HttpError, type Deps } from "./services/orders.js";
import { merchantRoutes } from "./routes/merchants.js";
import { orderRoutes } from "./routes/orders.js";
import { pouchRoutes } from "./routes/pouches.js";
import { statsRoutes } from "./routes/stats.js";
import { topupRoutes } from "./routes/topups.js";
import { ownedStore } from "./security/access.js";
import { withdrawalRoutes } from "./routes/withdrawals.js";
import { voiceRoutes } from "./routes/voice.js";
import { chatRoutes } from "./routes/chat.js";
import { profileRoutes } from "./routes/profile.js";
import { authRoutes } from "./routes/auth.js";
import { AuthUnavailableError, requireUser } from "./auth/session.js";
import { RateLimitError, RateLimitUnavailableError, rateLimit } from "./security/rateLimit.js";
import { execSync } from "node:child_process";

// The commit this process was started from, so /health shows which revision is live.
const RELEASE = process.env.RELEASE ?? (() => {
  try { return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch { return "unknown"; }
})();

const DEFAULT_ORIGINS = ["http://localhost:3000", "https://solpouch.tech", "https://www.solpouch.tech"];
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

export function createApp(deps: Deps) {
  const app = new Hono();
  const origins = process.env.WEB_ORIGINS
    ? process.env.WEB_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean)
    : DEFAULT_ORIGINS;

  app.use("*", secureHeaders());
  app.use("*", async(c,next) => { c.header("Cache-Control","no-store"); await next(); });
  app.use("*", bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ error: "Request body too large" } satisfies ApiError, 413) }));
  const stripeWebhook = (c: {req:{method:string;path:string}}) => c.req.method === "POST" && c.req.path === "/funding-webhooks/stripe";
  const corsMiddleware = cors({
      origin: (o) => (origins.includes(o) ? o : null),
      allowHeaders: ["Content-Type", "X-Solpouch-Secret", "Authorization"],
    });
  app.use("*", (c,next)=>stripeWebhook(c)?next():corsMiddleware(c,next));

  const writes = rateLimit({ store: deps.store, windowMs: MIN, max: 30, key: "write" });
  const topups = rateLimit({ store: deps.store, windowMs: MIN, max: 5, key: "topup" });
  const globalLimit=rateLimit({ store: deps.store, windowMs: MIN, max: 120, key: "all" });
  app.use("*", (c,next)=>stripeWebhook(c)?next():globalLimit(c,next));
  app.use("*", async (c, next) => {
    if(stripeWebhook(c)) return next();
    const m = c.req.method;
    return m === "POST" || m === "PATCH" || m === "DELETE" ? writes(c, next) : next();
  });
  app.on("POST", "/topups/*", topups);
  app.on("POST", "/withdrawals/*", rateLimit({ store: deps.store, windowMs: MIN, max: 5, key: "withdrawal" }));
  app.use("/voice/*", rateLimit({ store: deps.store, windowMs: MIN, max: 60, key: "voice" }));

  app.get("/health", (c) => c.json({ ok: true, release: RELEASE }));
  for (const base of ["/shopping-lists", "/pouches", "/orders", "/topups", "/stats", "/profile", "/funding"]) app.use(`${base}/*`, requireUser(deps.store));
  // Withdrawals run against a store scoped to the signed-in user: other accounts' pouches look missing (404).
  app.use("/withdrawals/*", requireUser(deps.store));
  app.use("/withdrawals/*", async (c, next) => {
    const email = (c as never as { get(k: "user"): { email: string } }).get("user").email;
    c.set("email", email);
    c.set("deps", { ...deps, store: ownedStore(deps.store, email) });
    await next();
  });
  // GET /chat/status is public (mode only); everything else under /chat needs a user.
  app.use("/chat/*", async (c, next) => (c.req.method === "GET" && c.req.path === "/chat/status" ? next() : requireUser(deps.store)(c as never, next)));
  app.route("/funding", stripeRoutes(deps));
  app.route("/funding-webhooks", stripeWebhookRoutes(deps));
  app.route("/funding", fundingRoutes(deps));
  app.route("/funding-webhooks", fundingWebhookRoutes(deps));
  app.route("/auth", authRoutes(deps, origins));
  app.route("/profile", profileRoutes(deps));
  app.route("/pouches", pouchRoutes(deps));
  app.route("/shopping-lists", shoppingListRoutes(deps));
  app.route("/orders", orderRoutes(deps));
  app.route("/topups", topupRoutes(deps));
  app.route("/withdrawals", withdrawalRoutes(deps));
  app.route("/merchants", merchantRoutes());
  app.route("/stats", statsRoutes(deps));
  app.route("/voice", voiceRoutes(deps));
  app.route("/chat", chatRoutes(deps));

  app.onError((err, c) => {
    if (err instanceof StoreConflictError) return c.json({ error: "This record changed. Refresh and try again.", code: "RecordChanged" } satisfies ApiError, 409);
    if (err instanceof InstacartError) return c.json({error:err.message,code:err.code},503);
    if (err instanceof OrderInputError) return c.json({error:err.message,code:"InvalidOrder"},422);
    if (err instanceof RateLimitError) { c.header("Retry-After", String(err.retryAfterSeconds)); return c.json({error:err.message},429); }
    if (err instanceof AuthUnavailableError || err instanceof RateLimitUnavailableError) return c.json({error:err.message},503);
    if (err instanceof CheckoutConfigurationError) return c.json({ error: err.message, code: "CheckoutNotConfigured" } satisfies ApiError, 503);
    // The program refused the instruction, so nothing changed on chain.
    if (err instanceof VaultRejected) return c.json({ error: `Vault rejected: ${err.code}`, code: err.code } satisfies ApiError, 422);
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
