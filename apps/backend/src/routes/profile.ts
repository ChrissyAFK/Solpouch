import { Hono } from "hono";
import { z } from "zod";
import { requireUser, type AuthEnv, type SessionUser } from "../auth/session.js";
import type { Deps } from "../services/orders.js";
import type { Store } from "../store/types.js";

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

const patchBody = z.object({
  displayName: z
    .string()
    .max(200)
    .transform((s) => s.replace(CONTROL, "").trim())
    .pipe(z.string().min(1).max(60))
    .nullable()
    .optional(),
  avatar: z
    .string()
    .max(60_000)
    .regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/)
    .nullable()
    .optional(),
});

/** Session user with name/picture overridden by the stored profile (read-only, creates nothing). */
export async function mergedUser(store: Store, u: SessionUser): Promise<SessionUser & { wallet?: string }> {
  const p = await store.getUser(u.email);
  return { ...u, name: p?.displayName ?? u.name, picture: p?.avatar ?? u.picture, ...(p?.wallet ? { wallet: p.wallet } : {}) };
}

export function profileRoutes(deps: Deps) {
  const app = new Hono<AuthEnv>();
  const { store } = deps;

  const shape = (g: SessionUser, p: { displayName?: string; avatar?: string; wallet?: string; createdAt: string }) => ({
    email: g.email,
    wallet: p.wallet,
    name: p.displayName ?? g.name,
    picture: p.avatar ?? g.picture,
    displayName: p.displayName ?? null,
    avatar: p.avatar ?? null,
    googleName: g.name,
    googlePicture: g.picture,
    createdAt: p.createdAt,
  });

  app.use("*", requireUser);

  app.get("/", async (c) => {
    const g = c.get("user");
    let p = await store.getUser(g.email);
    if (!p) {
      const now = new Date().toISOString();
      p = await store.saveUser({ email: g.email, createdAt: now, updatedAt: now });
    }
    return c.json(shape(g, p));
  });

  app.patch("/", async (c) => {
    const g = c.get("user");
    const body = patchBody.parse(await c.req.json());
    const now = new Date().toISOString();
    const prev = (await store.getUser(g.email)) ?? { email: g.email, createdAt: now, updatedAt: now };
    const next = { ...prev, updatedAt: now };
    if (body.displayName === null) delete next.displayName;
    else if (body.displayName !== undefined) next.displayName = body.displayName;
    if (body.avatar === null) delete next.avatar;
    else if (body.avatar !== undefined) next.avatar = body.avatar;
    return c.json(shape(g, await store.saveUser(next)));
  });

  return app;
}
