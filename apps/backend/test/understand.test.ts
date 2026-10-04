import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { understand, UNDERSTAND_PROMPT } from "../src/ai/understand.js";
import { SearchUnavailableError } from "../src/ai/storeMatch.js";

const m = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { create: m.create }; } }));
const reply = (input: unknown) => ({ content: [{ type: "tool_use", name: "shopping_list", input }] });

beforeEach(() => { vi.stubEnv("GEMINI_API_KEY", ""); vi.stubEnv("ANTHROPIC_API_KEY", "fake"); vi.spyOn(console, "warn").mockImplementation(() => {}); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); m.create.mockReset(); });

describe("understand", () => {
  it("returns items, store and service with no question", async () => {
    m.create.mockResolvedValue(reply({ store: "Popeyes", service: "Uber Eats", items: [{ requested: "3 piece tenders combo", qty: 1 }], clarify: null }));
    expect(await understand("3 piece tenders combo from Popeyes on Uber Eats")).toEqual({ store: "Popeyes", service: "Uber Eats", items: [{ requested: "3 piece tenders combo", qty: 1 }] });
    expect(m.create.mock.calls[0][1]).toMatchObject({ timeout: 8000 });
  });
  it("passes a clarifying question through", async () => {
    m.create.mockResolvedValue(reply({ items: [{ requested: "screws", qty: 1 }], clarify: { question: "What size and type of screws?", reason: "missing_detail" } }));
    expect((await understand("get me some screws")).clarify).toEqual({ question: "What size and type of screws?", reason: "missing_detail" });
  });
  it("asks what to order when there is nothing to buy", async () => {
    m.create.mockResolvedValue(reply({ items: [], clarify: null }));
    expect((await understand("hello there")).clarify).toEqual({ question: "What would you like me to order?", reason: "not_shopping" });
  });
  it("drops a malformed clarify and an over-long question", async () => {
    m.create.mockResolvedValue(reply({ items: [{ requested: "milk", qty: 1 }], clarify: { question: "", reason: "missing_detail" } }));
    expect((await understand("milk")).clarify).toBeUndefined();
    m.create.mockResolvedValue(reply({ items: [{ requested: "milk", qty: 1 }], clarify: { question: "x".repeat(400), reason: "nope" } }));
    const u = await understand("milk");
    expect(u.clarify?.question.length).toBeLessThanOrEqual(200);
    expect(u.clarify?.reason).toBe("missing_detail");
  });
  it("throws SearchUnavailableError when Claude fails, and never builds a regex cart", async () => {
    m.create.mockRejectedValue(new Error("overloaded"));
    await expect(understand("2 eggs and 1 bread")).rejects.toBeInstanceOf(SearchUnavailableError);
  });
  it("without a Claude key it uses the old parser (offline mode)", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    expect(await understand("2 eggs and 1 bread")).toMatchObject({ items: [{ requested: "eggs", qty: 2 }, { requested: "bread", qty: 1 }] });
    expect(m.create).not.toHaveBeenCalled();
  });
  it("the prompt forbids questions about everyday items", () => {
    expect(UNDERSTAND_PROMPT).toMatch(/everyday/i);
    expect(UNDERSTAND_PROMPT).toMatch(/Did you say/);
  });
});
