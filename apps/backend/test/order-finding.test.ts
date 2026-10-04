import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryStore } from "../src/store/memory.js";
import { getMerchant } from "../src/merchants/index.js";
import { MockVaultClient } from "../src/vault/mock.js";
import { createDraft, HttpError } from "../src/services/orders.js";
import { fallbackParse, parseRequest, PARSE_PROMPT } from "../src/ai/gemini.js";
import { findOnline, validateFind, SearchUnavailableError } from "../src/ai/findOnline.js";
import { ownedSeed, TEST_USER } from "./helpers.js";

const m = vi.hoisted(() => ({ parse: vi.fn(), find: vi.fn(), create: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { create: m.create }; } }));
vi.mock("../src/ai/gemini.js", async (orig) => {
  const actual = await orig<typeof import("../src/ai/gemini.js")>();
  return { ...actual, parseRequest: (t: string, ...r: any[]) => (m.parse.getMockImplementation() ? m.parse(t) : (actual.parseRequest as any)(t, ...r)) };
});
vi.mock("../src/ai/findOnline.js", async (orig) => {
  const actual = await orig<typeof import("../src/ai/findOnline.js")>();
  return { ...actual, findOnline: (...a: any[]) => (m.find.getMockImplementation() ? m.find(...a) : (actual.findOnline as any)(...a)) };
});

let store: MemoryStore;
let vault: MockVaultClient;
beforeEach(() => {
  vi.stubEnv("GEMINI_API_KEY", "");
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  store = new MemoryStore(ownedSeed());
  vault = new MockVaultClient(store, (id) => getMerchant(id)?.payTo);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); m.parse.mockReset(); m.find.mockReset(); m.create.mockReset(); });
const draft = (req: string, pouch?: string) => createDraft({ store, vault }, TEST_USER, req, pouch);
const fail = (p: Promise<unknown>) => p.then(() => { throw new Error("expected rejection"); }, (e) => e);
const web = (name: string, domain: string, requested: string) => ({ storeName: name, domain, items: [{ requested, name: requested, unitPrice: 5 }] });
const item = (requested: string) => ({ requested, qty: 1 });

describe("bug 1: the named store is kept", () => {
  it("fallbackParse extracts store and delivery service, not pouchHint", () => {
    expect(fallbackParse("a burger from McDonald's")).toMatchObject({ store: "McDonald's", items: [{ requested: "burger", qty: 1 }] });
    expect(fallbackParse("a pizza on Uber Eats")).toMatchObject({ service: "Uber Eats" });
  });
  it("claude parse returns store and service; prompt says pouchHint is never the store", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "fake");
    m.create.mockResolvedValue({ content: [{ type: "tool_use", name: "shopping_list", input: { store: "Tim Hortons", service: "DoorDash", items: [{ requested: "coffee", qty: 1 }] } }] });
    expect(await parseRequest("coffee from Tim Hortons on DoorDash")).toEqual({ store: "Tim Hortons", service: "DoorDash", items: [item("coffee")] });
    expect(PARSE_PROMPT).toMatch(/never the store/i);
    expect(m.create.mock.calls[0][0].tools[0].input_schema.properties.store).toBeDefined();
  });
  it("validateFind rejects a look-alike from another retailer, accepts store site or delivery listing", () => {
    const items = [item("burger")];
    const opts = { store: "McDonald's" };
    expect(validateFind(web("Walmart", "walmart.ca", "burger"), items, undefined, opts)).toBeNull();
    expect(validateFind(web("McDonald's", "mcdonalds.ca", "burger"), items, undefined, opts)).not.toBeNull();
    expect(validateFind(web("McDonalds Canada", "order.mcd.ca", "burger"), items, undefined, opts)).not.toBeNull();
    expect(validateFind(web("McDonald's", "ubereats.com", "burger"), items, undefined, opts)).not.toBeNull();
    expect(validateFind(web("Walmart", "ubereats.com", "burger"), items, undefined, opts)).toBeNull();
  });
  it("findOnline prompt requires the store", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "fake");
    m.create.mockResolvedValue({ content: [{ type: "text", text: "{}" }] });
    await findOnline([item("burger")], { store: "McDonald's", service: "Uber Eats" });
    expect(m.create.mock.calls[0][0].messages[0].content).toContain("McDonald's");
    expect(m.create.mock.calls[0][0].messages[0].content).not.toContain("Pick any real retailer");
  });
});

describe("bug 2: catalog look-alikes", () => {
  it("unknown store skips the catalog", async () => {
    m.parse.mockImplementation(() => ({ store: "McDonald's", items: [item("pad thai")] }));
    m.find.mockResolvedValue(null);
    const err = await fail(draft("pad thai from McDonald's", "groceries"));
    expect(m.find).toHaveBeenCalledWith([item("pad thai")], expect.objectContaining({ store: "McDonald's" }));
    expect(err).toBeInstanceOf(HttpError);
    expect(err.code).toBe("NotFound");
  });
  it("matching store restricts to that merchant", async () => {
    m.parse.mockImplementation(() => ({ store: "Thai Express", items: [item("pad thai")] }));
    const o = await draft("pad thai from Thai Express");
    expect(o.merchantId).toBe("thai-express");
    expect(m.find).not.toHaveBeenCalled();
  });
});

describe("bug 3: store but no items", () => {
  it("asks what they want", async () => {
    m.parse.mockImplementation(() => ({ store: "McDonald's", items: [] }));
    const err = await fail(draft("a McDonald's order"));
    expect(err).toMatchObject({ status: 400, code: "NeedItems", message: "What would you like from McDonald's?" });
    expect(fallbackParse("a McDonald's order")).toMatchObject({ store: "McDonald's", items: [] });
    expect(fallbackParse("get me something from Tim Hortons")).toMatchObject({ store: "Tim Hortons", items: [] });
  });
  it("no store and no items keeps the old 400", async () => {
    m.parse.mockImplementation(() => ({ items: [] }));
    expect(await fail(draft("hmm"))).toMatchObject({ status: 400, message: "Could not find any items in that request" });
  });
});

describe("bug 4: unavailable vs not found", () => {
  it("findOnline throws SearchUnavailableError on provider failure and returns null when nothing valid", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "fake");
    m.create.mockRejectedValue(Object.assign(new Error("boom"), { status: 529 }));
    await expect(findOnline([item("chainsaw")])).rejects.toBeInstanceOf(SearchUnavailableError);
    m.create.mockReset();
    m.create.mockResolvedValue({ content: [{ type: "text", text: "no products found" }] });
    expect(await findOnline([item("chainsaw")])).toBeNull();
  });
  it("createDraft: provider failure is 422 SearchUnavailable", async () => {
    m.parse.mockImplementation(() => ({ items: [item("zzqx gadget")] }));
    m.find.mockRejectedValue(new SearchUnavailableError("down"));
    expect(await fail(draft("zzqx gadget", "groceries"))).toMatchObject({ status: 422, code: "SearchUnavailable" });
  });
  it("createDraft: nothing found is 422 NotFound with a helpful message", async () => {
    m.parse.mockImplementation(() => ({ store: "Tim Hortons", items: [item("zzqx gadget"), item("flarp")] }));
    m.find.mockResolvedValue(null);
    const err = await fail(draft("zzqx gadget and flarp from Tim Hortons", "groceries"));
    expect(err).toMatchObject({ status: 422, code: "NotFound" });
    expect(err.message).toContain("zzqx gadget");
    expect(err.message).toContain("from Tim Hortons");
    expect(err.message).toContain("Try rewording or naming a store.");
  });
});

describe("bug 5: price limit reaches the search", () => {
  it("passes total and per-item caps in dollars", async () => {
    m.parse.mockImplementation(() => ({ items: [item("zzqx gadget")] }));
    m.find.mockResolvedValue(null);
    await fail(draft("zzqx gadget under $15", "groceries"));
    expect(m.find.mock.calls[0][1]).toMatchObject({ maxTotal: 15 });
    await fail(draft("zzqx gadget under $3 each", "groceries"));
    expect(m.find.mock.calls[1][1]).toMatchObject({ maxPerItem: 3 });
  });
  it("prompt carries the limit", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "fake");
    m.create.mockResolvedValue({ content: [{ type: "text", text: "{}" }] });
    await findOnline([item("gadget")], { maxTotal: 15 });
    expect(m.create.mock.calls[0][0].messages[0].content).toContain("Keep the order total under $15 CAD");
  });
});

describe("bug 6: web search timeout", () => {
  it("uses 45s and no retries for Claude web search", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "fake");
    m.create.mockResolvedValue({ content: [{ type: "text", text: "{}" }] });
    await findOnline([item("gadget")]);
    expect(m.create.mock.calls[0][1]).toEqual({ timeout: 45_000, maxRetries: 0 });
  });
});
