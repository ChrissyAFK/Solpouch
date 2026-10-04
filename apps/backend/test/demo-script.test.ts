import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isCheckoutReference } from "@solpouch/shared";
import { MemoryStore } from "../src/store/memory.js";
import { MockVaultClient } from "../src/vault/mock.js";
import { getMerchant } from "../src/merchants/index.js";
import { createDraft } from "../src/services/orders.js";
import { findOnline } from "../src/ai/findOnline.js";
import { SCRIPT_OVER_30_SAY, demoVoiceRequest, scriptedDemoMatch } from "../src/services/demoScript.js";
import { ownedSeed, TEST_USER } from "./helpers.js";

vi.mock("../src/ai/findOnline.js", () => ({ findOnline: vi.fn() }));
let store: MemoryStore;
const deps = () => ({ store, vault: new MockVaultClient(store, (id) => getMerchant(id)?.payTo) });
beforeEach(() => { process.env.DEMO_RETAILER_PAYMENTS = "1"; store = new MemoryStore(ownedSeed()); });
afterEach(() => { delete process.env.DEMO_RETAILER_PAYMENTS; });

describe("stage demo script", () => {
  it("matches only the two McDonald's lines, and only with demo payments on", () => {
    expect(scriptedDemoMatch("Can you make me a McDonald's order for under $15?")).toBe("under15");
    expect(scriptedDemoMatch("can you make me a mcdonalds order for under 15 dollars")).toBe("under15");
    expect(scriptedDemoMatch("Can you find me a McDonald's order for over $30?")).toBe("over30");
    expect(scriptedDemoMatch("a MacDonald's meal for less than fifteen bucks")).toBe("under15");
    expect(scriptedDemoMatch("McDonalds burger and fries")).toBe("under15");
    expect(scriptedDemoMatch("find me a mcdonald's order that costs more than thirty dollars")).toBe("over30");
    expect(scriptedDemoMatch("a chainsaw under $15")).toBeNull();
    delete process.env.DEMO_RETAILER_PAYMENTS;
    expect(scriptedDemoMatch("Can you make me a McDonald's order for under $15?")).toBeNull();
  });

  it("drafts a fixed CAD estimate under $15 without searching", async () => {
    const order = await createDraft(deps(), TEST_USER, "Can you make me a McDonald's order for under $15?", "groceries");
    expect(findOnline).not.toHaveBeenCalled();
    expect(order.lines.map((l) => l.product?.name)).toEqual(["Big Mac", "Medium Fries", "Medium Coca-Cola"]);
    expect(order.total).toBe(12_970_000);
    expect(order.status).toBe("draft");
    expect(isCheckoutReference(order)).toBe(true);
  });

  it("refuses the over $30 request as over the daily limit", async () => {
    await expect(createDraft(deps(), TEST_USER, "Can you find me a McDonald's order for over $30?", "groceries")).rejects.toMatchObject({ message: SCRIPT_OVER_30_SAY, code: "DailyLimitExceeded" });
  });

  it("turns any spoken order into a scripted one in demo mode", () => {
    expect(scriptedDemoMatch(demoVoiceRequest("50 novels"))).toBe("under15");
    expect(scriptedDemoMatch(demoVoiceRequest("McDonald's for more than thirty"))).toBe("over30");
    delete process.env.DEMO_RETAILER_PAYMENTS;
    expect(demoVoiceRequest("50 novels")).toBe("50 novels");
  });
});
