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
import { requireUser } from "./auth/session.js";
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
  app.use("*", bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ error: "Request body too large" } satisfies ApiError, 413) }));
  app.use(
    "*",
    cors({
      origin: (o) => (origins.includes(o) ? o : null),
      allowHeaders: ["Content-Type", "X-Solpouch-Secret", "Authorization"],
    }),
  );

  // Cloudflare tunnel traffic (ElevenLabs webhooks) may only reach /health and /voice/*.
  app.use("*", async (c, next) => {
    if (c.req.header("cf-connecting-ip") && process.env.PUBLIC_API !== "all") {
      const p = c.req.path;
      if (p !== "/health" && p !== "/voice" && !p.startsWith("/voice/")) return c.json({ error: "Not found" }, 404);
    }
    await next();
  });

  const writes = rateLimit({ windowMs: MIN, max: 30, key: "write" });
  const gemini = rateLimit({ windowMs: MIN, max: 10, key: "gemini-min" });
  const geminiDay = rateLimit({ windowMs: DAY, max: 200, key: "gemini-day" });
  const topups = rateLimit({ windowMs: MIN, max: 5, key: "topup" });
  app.use("*", rateLimit({ windowMs: MIN, max: 120, key: "all" }));
  app.use("*", async (c, next) => {
    const m = c.req.method;
    return m === "POST" || m === "PATCH" ? writes(c, next) : next();
  });
  app.on("POST", ["/chat", "/orders"], gemini, geminiDay);
  app.on("POST", "/topups/*", topups);
  app.use("/voice/*", rateLimit({ windowMs: MIN, max: 60, key: "voice" }));

  app.get("/health", (c) => c.json({ ok: true }));
  for (const base of ["/pouches", "/orders", "/topups", "/stats", "/profile"]) app.use(`${base}/*`, requireUser);
  // GET /chat/status is public (mode only); everything else under /chat needs a user.
  app.use("/chat/*", async (c, next) => (c.req.method === "GET" && c.req.path === "/chat/status" ? next() : requireUser(c as never, next)));
  app.route("/auth", authRoutes(deps));
  app.route("/profile", profileRoutes(deps));
  app.route("/pouches", pouchRoutes(deps));
  app.route("/orders", orderRoutes(deps));
  app.route("/topups", topupRoutes(deps));
  app.route("/merchants", merchantRoutes());
  app.route("/stats", statsRoutes(deps));
  app.route("/voice", voiceRoutes(deps));
  app.route("/chat", chatRoutes(deps));

  app.onError((err, c) => {
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
