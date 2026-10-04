import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { getMerchant } from "../src/merchants/index.js";
import { MemoryStore } from "../src/store/memory.js";
import { MockVaultClient } from "../src/vault/mock.js";
import { ownedSeed } from "./helpers.js";

describe("chat auth", () => {
  const store = new MemoryStore(ownedSeed());
  const vault = new MockVaultClient(store, (id) => getMerchant(id)?.payTo, () => 1_000_000);
  const app = createApp({ store, vault });

  it("GET /chat/status is public, POST /chat still needs auth", async () => {
    expect((await app.request("/chat/status")).status).toBe(200);
    const r = await app.request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hi" }),
    });
    expect(r.status).toBe(401);
  });
});
