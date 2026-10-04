import { OrderInputError } from "../services/orderValidation.js";
import { finishParse, PARSE_PROMPT, parseRequest, type ParsedRequest } from "./gemini.js";
import { aiProvider, claudeJson } from "./provider.js";
import { SearchUnavailableError } from "./storeMatch.js";

export type ClarifyReason = "missing_detail" | "misheard" | "not_shopping";
export interface Understood extends ParsedRequest {
  /** Set when the assistant must ask the user one question before searching. */
  clarify?: { question: string; reason: ClarifyReason };
}

export const UNDERSTAND_PROMPT = `${PARSE_PROMPT}
Also return "clarify": null, or { "question": string, "reason": "missing_detail" | "misheard" | "not_shopping" }.
The text may come from speech recognition. Set "clarify" ONLY in these cases, otherwise it is null:
- "misheard": the text is not plausible as something a person would ask a shopping assistant to buy, or reads like a speech-recognition error (for example "50 novels" or "by me a pop ice"). Ask "Did you say ...?" with your best guess of what was meant.
- "missing_detail": a wrong guess would be useless, for example fasteners, lumber, parts or cables with no size or type, or clothing and shoes with no size. Ask for exactly the missing detail.
- "not_shopping": the text is not a request to buy anything. Ask what they would like to order.
NEVER ask about everyday items that have a sensible default (milk, eggs, bread, coffee, a burger, fries, a pizza, toilet paper): choose the common default and leave "clarify" null.
A count that is part of how the product is sold stays in "requested" with qty 1: "20 Timbits" is { "requested": "20 pack of Timbits", "qty": 1 }, and the same goes for "10 McNuggets", "a dozen eggs" and "a 12 pack of Coke". Use a qty above 1 only for separate units ("two crunchy tacos", "3 boxes of screws", "ten 2x4 studs").
"store" is only the name of a specific business ("Popeyes", "Home Depot"). A kind of place ("an Indian restaurant in Burnaby", "a Thai place", "a hardware store") is not a store: set "store" to null and keep those words in each item's "requested" ("butter chicken from an Indian restaurant in Burnaby").
A store with a budget but no items ("a Popeyes meal under $15") is complete: leave "clarify" null.
The question is one short spoken sentence, under 20 words. When "clarify" is set, still fill "items" as best you can.`;

const UNDERSTAND_SCHEMA = {
  type: "object",
  properties: {
    pouchHint: { type: ["string", "null"] },
    store: { type: ["string", "null"] },
    service: { type: ["string", "null"] },
    items: {
      type: "array",
      items: { type: "object", properties: { requested: { type: "string" }, qty: { type: "number" } }, required: ["requested", "qty"] },
    },
    clarify: {
      type: ["object", "null"],
      properties: { question: { type: "string" }, reason: { type: "string", enum: ["missing_detail", "misheard", "not_shopping"] } },
      required: ["question", "reason"],
    },
  },
  required: ["items"],
};

const REASONS: ClarifyReason[] = ["missing_detail", "misheard", "not_shopping"];

/** Turn a request into a shopping list, or one question to ask first. */
export async function understand(text: string): Promise<Understood> {
  // Gemini and offline mode keep the old parser; they cannot ask questions.
  if (aiProvider() !== "claude") return parseRequest(text);
  let raw: any;
  try {
    raw = await claudeJson<any>({ system: UNDERSTAND_PROMPT, prompt: text, schema: UNDERSTAND_SCHEMA, name: "shopping_list", maxTokens: 1024, timeoutMs: 5000 });
  } catch (e) {
    console.warn("[claude] understand failed:", (e as Error).message);
    throw new SearchUnavailableError("The assistant is unavailable right now");
  }
  let parsed: ParsedRequest | null;
  try {
    parsed = finishParse(raw);
  } catch (e) {
    if (e instanceof OrderInputError) throw e;
    parsed = null;
  }
  const q = typeof raw?.clarify?.question === "string" ? raw.clarify.question.replace(/\s+/g, " ").trim().slice(0, 200) : "";
  const clarify = q ? { question: q, reason: REASONS.includes(raw.clarify.reason) ? (raw.clarify.reason as ClarifyReason) : "missing_detail" } : undefined;
  if (!parsed) return { items: [], clarify: clarify ?? { question: "What would you like me to order?", reason: "not_shopping" } };
  return clarify ? { ...parsed, clarify } : parsed;
}
