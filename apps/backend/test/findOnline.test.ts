import { afterEach, beforeEach, expect, it, vi } from "vitest";
const { generateContent } = vi.hoisted(() => ({ generateContent: vi.fn() }));
vi.mock("@google/genai", () => ({ GoogleGenAI: class { models = { generateContent }; } }));
import { findOnline } from "../src/ai/findOnline.js";
beforeEach(() => vi.stubEnv("ANTHROPIC_API_KEY", ""));
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
it("returns no quote when search is not configured", async () => {
  vi.stubEnv("GEMINI_API_KEY", "");
  expect(await findOnline([{ requested: "chainsaw", qty: 1 }])).toBeNull();
});
it("provider failure does not fabricate products or prices", async () => {
  vi.stubEnv("GEMINI_API_KEY", "fixture-key");
  generateContent.mockRejectedValueOnce(new Error("fixture provider failure"));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  expect(await findOnline([{ requested: "chainsaw", qty: 1 }])).toBeNull();
});
it("invalid search results do not fabricate a replacement quote", async () => {
  vi.stubEnv("GEMINI_API_KEY", "fixture-key");
  generateContent.mockResolvedValueOnce({ text: "no products found" });
  expect(await findOnline([{ requested: "chainsaw", qty: 1 }])).toBeNull();
});
