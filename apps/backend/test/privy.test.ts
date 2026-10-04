import { beforeEach, describe, expect, it } from "vitest";
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify } from "jose";
import { createApp } from "../src/app.js";
import { getMerchant } from "../src/merchants/index.js";
import { MemoryStore } from "../src/store/memory.js";
import { MockVaultClient } from "../src/vault/mock.js";
import { authHeaders, ownedSeed, TEST_USER } from "./helpers.js";

let app: ReturnType<typeof createApp>;
let auth: Record<string, string>;
beforeEach(async () => {
  const store = new MemoryStore(ownedSeed());
  app = createApp({ store, vault: new MockVaultClient(store, (id) => getMerchant(id)?.payTo) });
  auth = await authHeaders(store);
});

describe("privy token", () => {
  it("requires sign-in", async () => {
    expect((await app.request("/auth/privy-token")).status).toBe(401);
  });
  it("mints a token that verifies against the public JWKS", async () => {
    const res = await app.request("/auth/privy-token", { headers: auth });
    expect(res.status).toBe(200);
    const { token, expiresAt } = await res.json();
    const jwksRes = await app.request("/auth/privy-jwks");
    const jwks = await jwksRes.json();
    expect(decodeProtectedHeader(token)).toMatchObject({ alg: "ES256", kid: "solpouch-privy-1", typ: "JWT" });
    const { payload } = await jwtVerify(token, createLocalJWKSet(jwks), { issuer: "solpouch", audience: "privy" });
    expect(payload.sub).toBe(TEST_USER);
    expect(payload.exp! - payload.iat!).toBe(3600);
    expect(Date.parse(expiresAt)).toBe(payload.exp! * 1000);
  });
  it("serves the JWKS publicly without private fields", async () => {
    const res = await app.request("/auth/privy-jwks");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300");
    const { keys } = await res.json();
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({ kty: "EC", crv: "P-256", kid: "solpouch-privy-1", alg: "ES256", use: "sig" });
    expect(keys[0]).not.toHaveProperty("d");
  });
});
