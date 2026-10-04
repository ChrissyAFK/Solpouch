import { reconcilePouches } from "../services/reconcile.js";
import { requestDeps } from "../security/access.js";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { chatMode, demoReply, geminiReply } from "../ai/chat.js";
import { type Deps } from "../services/orders.js";
import { publicPouch } from "../store/types.js";

const chatBody = z.object({
  messages: z.array(z.object({
    role: z.enum(["user", "assistant"]),
    content: z.string().trim().min(1).max(2000),
  }).strict()).min(1).max(20),
}).strict().refine((b) => b.messages[b.messages.length - 1]?.role === "user", {
  message: "The last message must be from the user", path: ["messages"],
});

export function chatRoutes(_baseDeps: Deps) {
  const app = new Hono();
  app.get("/status", (c) => c.json({ mode: chatMode() }));
  app.post("/", bodyLimit({ maxSize: 192_000, onError: (c) => c.json({ error: "Chat request is too large." }, 413) }), async (c) => {
    const deps = requestDeps(c);
    const { messages } = chatBody.parse(await c.req.json());
    const mode = chatMode();
    const [stored, orders] = await Promise.all([deps.store.listPouches(), deps.store.listOrders()]);
    const pouches = stored.map(publicPouch);
    const context = { pouches, orders: [...orders].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 10) };
    if (mode === "demo") return c.json({ reply: demoReply(messages, context), mode });
    try {
      return c.json({ reply: await geminiReply(messages, context), mode });
    } catch {
      // Provider exceptions can contain keys or request contents; never return or log them.
      return c.json({ error: "The AI assistant is temporarily unavailable. Please try again shortly." }, 503);
    }
  });
  return app;
}
