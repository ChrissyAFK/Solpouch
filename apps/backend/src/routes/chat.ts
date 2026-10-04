import { consumeAiBudget } from "../security/rateLimit.js";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { chatMode, demoReply, geminiReply, claudeReply } from "../ai/chat.js";
import type { AuthEnv } from "../auth/session.js";
import { listOwnedOrders, type Deps } from "../services/orders.js";
import { publicPouch } from "../store/types.js";

const chatBody = z.object({
  messages: z.array(z.object({
    role: z.enum(["user", "assistant"]),
    content: z.string().trim().min(1).max(2000),
  }).strict()).min(1).max(20),
}).strict().refine((b) => b.messages[b.messages.length - 1]?.role === "user", {
  message: "The last message must be from the user", path: ["messages"],
});

export function chatRoutes(deps: Deps) {
  const app = new Hono<AuthEnv>();
  app.get("/status", (c) => c.json({ mode: chatMode() }));
  app.post("/", bodyLimit({ maxSize: 192_000, onError: (c) => c.json({ error: "Chat request is too large." }, 413) }), async (c) => {
    const { messages } = chatBody.parse(await c.req.json());
    const mode = chatMode();
    const email = c.get("user").email;
    await consumeAiBudget(deps.store, email);
    const [stored, orders] = await Promise.all([deps.store.listPouches(email), listOwnedOrders(deps, email)]);
    const pouches = stored.map(publicPouch);
    const context = { pouches, orders: [...orders].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 10) };
    if (mode === "demo") return c.json({ reply: demoReply(messages, context), mode });
    try {
      return c.json({ reply: await (mode === "claude" ? claudeReply : geminiReply)(messages, context), mode });
    } catch {
      // Provider exceptions can contain keys or request contents; never return or log them.
      return c.json({ error: "The AI assistant is temporarily unavailable. Please try again shortly." }, 503);
    }
  });
  return app;
}
