import { createPrivateKey, sign } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair } from "@solana/web3.js";
import { createApp } from "../src/app.js";
import { getMerchant } from "../src/merchants/index.js";
import { MemoryStore } from "../src/store/memory.js";
import { MockVaultClient } from "../src/vault/mock.js";
import { validSignature, validWallet } from "../src/security/wallet.js";
import { authHeaders, ownedSeed, TEST_USER } from "./helpers.js";

const ORIGIN = "http://localhost:3000";
const OTHER = "other@example.com";
let store: MemoryStore;
let app: ReturnType<typeof createApp>;
let auth: Record<string, string>;
beforeEach(async () => {
  delete process.env.WEB_ORIGINS;
  store = new MemoryStore([...ownedSeed(), ...ownedSeed(OTHER).map((p) => ({ ...p, id: `o-${p.id}`, address: `o-${p.address}` }))]);
  app = createApp({ store, vault: new MockVaultClient(store, (id) => getMerchant(id)?.payTo) });
  auth = await authHeaders(store);
});
afterEach(() => vi.useRealTimers());

/** Sign UTF-8 text the way a Solana wallet's signMessage does (raw ed25519). */
function signText(kp: Keypair, text: string) {
  const der = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(kp.secretKey.slice(0, 32))]);
  return sign(null, Buffer.from(text), createPrivateKey({ key: der, format: "der", type: "pkcs8" })).toString("base64");
}
const call = (path: string, headers: Record<string, string>, body?: unknown, method = "POST", origin: string | null = ORIGIN) =>
  app.request(path, { method, headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
async function challenge(kp: Keypair, headers = auth, origin: string | null = ORIGIN) {
  return call("/auth/wallet/challenge", headers, { wallet: kp.publicKey.toBase58() }, "POST", origin);
}
async function link(kp: Keypair, headers = auth) {
  const c = await (await challenge(kp, headers)).json();
  return call("/auth/wallet/verify", headers, { id: c.id, signature: signText(kp, c.message) });
}
const topUp = (headers = auth) => call("/topups", headers, { pouchId: "uber-eats", amount: 5_000_000 });

describe("wallet linking", () => {
  it("validates addresses and signatures", () => {
    const kp = Keypair.generate();
    expect(validWallet(kp.publicKey.toBase58())).toBe(true);
    expect(validWallet("not-a-wallet")).toBe(false);
    expect(validSignature(kp.publicKey.toBase58(), "hi", signText(kp, "hi"))).toBe(true);
    expect(validSignature(kp.publicKey.toBase58(), "hi!", signText(kp, "hi"))).toBe(false);
    expect(validSignature(Keypair.generate().publicKey.toBase58(), "hi", signText(kp, "hi"))).toBe(false);
  });

  it("top-ups need a linked wallet and record it", async () => {
    const blocked = await topUp();
    expect(blocked.status).toBe(403);
    expect(await blocked.json()).toMatchObject({ error: "Link a wallet to add money", code: "WalletRequired" });
    expect(await store.listTopUps("uber-eats")).toEqual([]);
    const kp = Keypair.generate();
    const linked = await link(kp);
    expect(linked.status).toBe(200);
    expect((await linked.json()).user).toMatchObject({ email: TEST_USER, wallet: kp.publicKey.toBase58() });
    const started = await topUp();
    expect(started.status).toBe(201);
    expect((await started.json()).fromWallet).toBe(kp.publicKey.toBase58());
    expect((await (await app.request("/auth/me", { headers: auth })).json()).user.wallet).toBe(kp.publicKey.toBase58());
    expect((await (await app.request("/profile", { headers: auth })).json()).wallet).toBe(kp.publicKey.toBase58());
  });

  it("challenges require sign-in, an allowed origin and a real wallet", async () => {
    const kp = Keypair.generate();
    expect((await challenge(kp, {})).status).toBe(401);
    expect((await challenge(kp, auth, null)).status).toBe(403);
    expect((await challenge(kp, auth, "https://evil.example")).status).toBe(403);
    expect((await call("/auth/wallet/challenge", auth, { wallet: "x".repeat(44) })).status).toBe(400);
    const body = await (await challenge(kp)).json();
    expect(body.message).toContain(TEST_USER);
    expect(body.message).toContain(`URI: ${ORIGIN}`);
    expect(body.message).toContain("does not approve a transaction");
  });

  it("proofs are single use and bound to the signer, session, account and origin", async () => {
    const kp = Keypair.generate();
    const verify = async (headers: Record<string, string>, mutate: (c: { id: string; message: string }) => { id: string; signature: string }, origin = ORIGIN) => {
      const c = await (await challenge(kp)).json();
      return (await call("/auth/wallet/verify", headers, mutate(c), "POST", origin)).status;
    };
    expect(await verify(auth, (c) => ({ id: c.id, signature: signText(Keypair.generate(), c.message) }))).toBe(400);
    expect(await verify(auth, (c) => ({ id: c.id, signature: signText(kp, c.message + " ") }))).toBe(400);
    expect(await verify(await authHeaders(store), (c) => ({ id: c.id, signature: signText(kp, c.message) }))).toBe(400); // another session
    expect(await verify(await authHeaders(store, OTHER), (c) => ({ id: c.id, signature: signText(kp, c.message) }))).toBe(400);
    expect(await verify(auth, (c) => ({ id: c.id, signature: signText(kp, c.message) }), "https://www.solpouch.tech")).toBe(400);
    expect((await store.getUser(TEST_USER))?.wallet).toBeUndefined();

    const c = await (await challenge(kp)).json();
    const body = { id: c.id, signature: signText(kp, c.message) };
    expect((await call("/auth/wallet/verify", auth, body)).status).toBe(200);
    await store.setWallet(TEST_USER, null);
    expect((await call("/auth/wallet/verify", auth, body)).status).toBe(400); // replay
  });

  it("expired proofs are rejected", async () => {
    const kp = Keypair.generate();
    const c = await (await challenge(kp)).json();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 5 * 60_000 + 1);
    expect((await call("/auth/wallet/verify", auth, { id: c.id, signature: signText(kp, c.message) })).status).toBe(400);
  });

  it("keeps one wallet per account and one account per wallet", async () => {
    const mine = Keypair.generate(), theirs = Keypair.generate();
    const other = await authHeaders(store, OTHER);
    expect((await link(theirs, other)).status).toBe(200);
    expect((await challenge(theirs)).status).toBe(409);
    expect((await link(mine)).status).toBe(200);
    expect((await link(mine)).status).toBe(200); // relinking the same wallet is idempotent
    expect((await challenge(Keypair.generate())).status).toBe(409);

    // A profile edit never drops the link.
    expect((await call("/profile", auth, { displayName: "New name" }, "PATCH")).status).toBe(200);
    expect((await store.getUser(TEST_USER))?.wallet).toBe(mine.publicKey.toBase58());

    const unlinked = await call("/auth/wallet", auth, undefined, "DELETE");
    expect((await unlinked.json()).user.wallet).toBeUndefined();
    expect((await topUp()).status).toBe(403);
    expect((await link(Keypair.generate())).status).toBe(200);
  });

  it("two challenges issued while unlinked cannot both link: the second verify gets 409", async () => {
    const first = Keypair.generate(), second = Keypair.generate();
    const c1 = await (await challenge(first)).json();
    const c2 = await (await challenge(second)).json();
    expect((await call("/auth/wallet/verify", auth, { id: c1.id, signature: signText(first, c1.message) })).status).toBe(200);
    // Model the race: the second verify's pre-check read the account before the first link landed.
    vi.spyOn(store, "getUser").mockResolvedValueOnce(undefined);
    const r2 = await call("/auth/wallet/verify", auth, { id: c2.id, signature: signText(second, c2.message) });
    expect(r2.status).toBe(409);
    expect((await r2.json()).error).toContain("Unlink your current wallet");
    expect((await store.getUser(TEST_USER))?.wallet).toBe(first.publicKey.toBase58());
  });

  it("the store links conditionally: only when unlinked or relinking the same wallet", async () => {
    const a = Keypair.generate().publicKey.toBase58(), b = Keypair.generate().publicKey.toBase58();
    await store.setWallet(TEST_USER, a);
    await expect(store.setWallet(TEST_USER, a)).resolves.toMatchObject({ wallet: a });
    await expect(store.setWallet(TEST_USER, b)).rejects.toMatchObject({ name: "WalletAlreadyLinkedError" });
    expect((await store.getUser(TEST_USER))?.wallet).toBe(a);
    await store.setWallet(TEST_USER, null);
    await expect(store.setWallet(TEST_USER, b)).resolves.toMatchObject({ wallet: b });
  });

  it("a wallet claimed between challenge and verify is refused", async () => {
    const kp = Keypair.generate();
    const c = await (await challenge(kp)).json();
    await store.setWallet(OTHER, kp.publicKey.toBase58());
    expect((await call("/auth/wallet/verify", auth, { id: c.id, signature: signText(kp, c.message) })).status).toBe(409);
    expect((await store.getUser(TEST_USER))?.wallet).toBeUndefined();
  });
});
