import { Hono } from "hono";
import { cors } from "hono/cors";
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

export function createApp(deps: Deps) {
  const app = new Hono();
  app.use("*", cors({ origin: "*", allowHeaders: ["Content-Type", "X-Solpouch-Secret"] }));
  app.get("/health", (c) => c.json({ ok: true }));
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
