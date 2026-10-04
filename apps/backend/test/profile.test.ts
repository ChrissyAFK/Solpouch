import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { MemoryStore } from "../src/store/memory.js";
import { MockVaultClient } from "../src/vault/mock.js";
import { authHeaders } from "./helpers.js";

delete process.env.GEMINI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ELEVENLABS_TOOL_SECRET;

const A = "a@example.com";
const B = "b@example.com";
const AV = "data:image/png;base64,iVBORw0KGgo=";

let app: ReturnType<typeof createApp>;
beforeEach(() => {
  const store = new MemoryStore([]);
  app = createApp({ store, vault: new MockVaultClient(store, () => undefined, () => 1_000_000) });
});

const req = async (method: string, path: string, who: string | null, body?: unknown) =>
  app.request(path, {
    method,
    headers: { "Content-Type": "application/json", ...(who ? await authHeaders(who) : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe("profile", () => {
  it("requires auth", async () => {
    expect((await req("GET", "/profile", null)).status).toBe(401);
    expect((await req("PATCH", "/profile", null, {})).status).toBe(401);
  });

  it("defaults to google values", async () => {
    const res = await req("GET", "/profile", A);
    expect(res.status).toBe(200);
    const p = await res.json();
    expect(p).toMatchObject({ email: A, name: "Test User", picture: "", displayName: null, avatar: null, googleName: "Test User" });
    expect(typeof p.createdAt).toBe("string");
  });

  it("patches name and avatar, reflected in GET and /auth/me, null resets", async () => {
    const first = await (await req("GET", "/profile", A)).json();
    const res = await req("PATCH", "/profile", A, { displayName: "  Al\u0007ice ", avatar: AV });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ name: "Alice", picture: AV, displayName: "Alice", avatar: AV, googleName: "Test User", createdAt: first.createdAt });
    expect(await (await req("GET", "/profile", A)).json()).toMatchObject({ name: "Alice", picture: AV });
    expect((await (await req("GET", "/auth/me", A)).json()).user).toMatchObject({ name: "Alice", picture: AV });
    const r = await req("PATCH", "/profile", A, { displayName: null, avatar: null });
    expect(await r.json()).toMatchObject({ name: "Test User", picture: "", displayName: null, avatar: null });
  });

  it("rejects bad avatars", async () => {
    for (const avatar of ["data:image/gif;base64,AAAA", "data:image/png;base64," + "A".repeat(60_000), "data:image/png;base64,not base64!", "http://x/y.png"])
      expect((await req("PATCH", "/profile", A, { avatar })).status).toBe(400);
  });

  it("rejects bad names", async () => {
    expect((await req("PATCH", "/profile", A, { displayName: "" })).status).toBe(400);
    expect((await req("PATCH", "/profile", A, { displayName: "   " })).status).toBe(400);
    expect((await req("PATCH", "/profile", A, { displayName: "x".repeat(61) })).status).toBe(400);
    expect((await req("PATCH", "/profile", A, { displayName: "x".repeat(60) })).status).toBe(200);
  });

  it("isolates users", async () => {
    await req("PATCH", "/profile", A, { displayName: "Alice" });
    const b = await (await req("GET", "/profile", B)).json();
    expect(b).toMatchObject({ email: B, name: "Test User", displayName: null });
  });
});
