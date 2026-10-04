import { afterEach, describe, expect, it, vi } from "vitest";
import { createInstacartList, trustedInstacartUrl } from "../src/services/instacart.js";
import { createApp } from "../src/app.js";
import { MemoryStore } from "../src/store/memory.js";
import { MockVaultClient } from "../src/vault/mock.js";
import { getMerchant } from "../src/merchants/index.js";
import { createDraft } from "../src/services/orders.js";
import { authHeaders, ownedSeed, TEST_USER } from "./helpers.js";
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
const link = "https://www.instacart.com/store/shopping_lists/fixture";
describe("Instacart shopping-list handoff", () => {
  it("requires configuration without making a provider call", async () => {
    vi.stubEnv("INSTACART_API_KEY", ""); const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await expect(createInstacartList("Groceries", [{ name: "eggs", quantity: 2 }])).rejects.toMatchObject({ code: "InstacartNotConfigured" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("uses documented measurements and rejects untrusted links", async () => {
    vi.stubEnv("INSTACART_API_KEY", "fixture"); vi.stubEnv("INSTACART_ENV", "dev");
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ products_link_url: link })));
    vi.stubGlobal("fetch", fetch);
    expect((await createInstacartList("Groceries", [{ name: "eggs", quantity: 2 }])).checkoutUrl).toBe(link);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("https://connect.dev.instacart.tools/idp/v1/products/products_link");
    expect(JSON.parse(init.body)).toMatchObject({ link_type: "shopping_list", line_items: [{ name: "eggs", line_item_measurements: [{ quantity: 2, unit: "each" }] }] });
    for (const value of ["javascript:alert(1)", "https://instacart.com.evil.example/cart", "https://user:pass@instacart.com/cart", "http://instacart.com/cart"]) expect(trustedInstacartUrl(value)).toBeUndefined();
  });
  it("returns a safe error for provider failures", async () => {
    vi.stubEnv("INSTACART_API_KEY", "fixture"); vi.stubEnv("INSTACART_ENV", "dev");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("sensitive provider error", {status:500})));
    await expect(createInstacartList("Groceries", [{ name: "eggs", quantity: 2 }])).rejects.toMatchObject({ code:"InstacartUnavailable",message:expect.not.stringContaining("sensitive") });
  });
  it("persists and reuses links without moving funds, enforcing ownership and blocking duplicate checkout payment", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");vi.stubEnv("ANTHROPIC_API_KEY", "");vi.stubEnv("INSTACART_API_KEY", "fixture");vi.stubEnv("INSTACART_ENV", "dev");
    const fetch=vi.fn().mockImplementation(async()=>new Response(JSON.stringify({products_link_url:link}))); vi.stubGlobal("fetch",fetch);
    const store=new MemoryStore(ownedSeed());const vault=new MockVaultClient(store,id=>getMerchant(id)?.payTo); const app=createApp({store,vault});
    const order=await createDraft({store,vault},TEST_USER,"2 eggs","groceries"); const balance=(await store.getPouch("groceries"))!.balance;
    const headers=await authHeaders(store);
    expect((await app.request(`/orders/${order.id}/instacart`,{method:"POST",headers:await authHeaders(store,"other@example.test")})).status).toBe(404);
    for(let i=0;i<2;i++) { const response=await app.request(`/orders/${order.id}/instacart`,{method:"POST",headers});expect(response.status).toBe(200);expect((await response.json()).fulfillment.checkoutUrl).toBe(link); }
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await store.getPouch("groceries"))!.balance).toBe(balance);
    expect((await store.getOrder(order.id))!.status).toBe("draft");
    const pay=await app.request(`/orders/${order.id}/confirm`,{method:"POST",headers});expect(pay.status).toBe(422);
  });
});
