import { toMicros, type Micros } from "@solpouch/shared";

export interface RequestConstraints {
  /** Price cap in micro-USDC (same units as Order.total). Absent when none or not parseable. */
  maxPrice?: Micros;
  /** True when a cap is stated per item ("under $2 each"), so it cannot be compared with the order total. */
  perItem?: boolean;
  /** True when the text states any price limit, parseable or not. */
  hasConstraint: boolean;
}

const LEAD = String.raw`(?:under|below|beneath|less\s+than|lower\s+than|cheaper\s+than|no\s+(?:more|higher|greater)\s+than|not\s+(?:more|over|above|exceeding)(?:\s+than)?|at\s+most|up\s*to|max(?:imum)?(?:\s+price)?(?:\s+of)?|budget\s+(?:of|is)|within|<=?|≤)`;
const NUM = String.raw`(?:\$\s*)?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+|,\d{1,2}(?!\d))?)`;
const UNIT = String.raw`(?:\s*(dollars?|bucks?|usd|cents?|¢))?`;
// A bare number must end the phrase (so "under 4 people" is not a price).
// Any money or limit word: the request may carry a cap we could not parse, so it always needs approval.
const LOOSE_RE = /[$¢]|\b(?:dollars?|bucks?|usdc?|cents?|limit|cap|capped|max(?:imum)?|spend)\b/i;
const PER_ITEM_RE = /^\s*(?:each|per\b|apiece|a\s+piece|\/)/i;
const BARE_END = /^(?:\s*(?:$|[.,;!?)])|\s+(?:or|and|please|total|each|per|for|at|from|in|on)\b)/i;

const LEAD_RE = new RegExp(String.raw`(?:^|[^a-z])${LEAD}\s*${NUM}${UNIT}`, "gi");
const TRAIL_RE = new RegExp(String.raw`(?:for\s+)?${NUM}${UNIT}\s+(?:or\s+(?:less|under|below|cheaper|fewer)|max(?:imum)?|tops|at\s+most)\b`, "gi");
const UNPARSED_RE = /\b(cheapest|cheaper|cheap|as\s+cheap(?:ly)?\s+as\s+possible|lowest\s+price|best\s+price|best\s+deal|on\s+sale|sale\s+only|discount(?:ed)?|budget|inexpensive|least\s+expensive|low[- ]cost|bargain|affordable|economical)\b/i;

function toUnits(raw: string, unit: string | undefined, hadDollar: boolean, bareOk: boolean): Micros | undefined {
  // "1,000" is a thousands separator; "1,50" is a decimal comma.
  const n = Number(/,\d{3}/.test(raw) ? raw.replace(/,/g, "") : raw.replace(",", "."));
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const u = unit?.toLowerCase();
  if (u && (u.startsWith("cent") || u === "¢")) return toMicros(n / 100);
  if (u || hadDollar || bareOk) return toMicros(n);
  return undefined;
}

/** Deterministic price-cap detection on the raw request text. */
export function parseRequestConstraints(text: string): RequestConstraints {
  const caps: Micros[] = [];
  let perItem = false;
  const t = text ?? "";
  const hit = (re: RegExp, needsUnit: boolean) => {
    for (const m of t.matchAll(re)) {
      const whole = m[0];
      const end = (m.index ?? 0) + whole.length;
      const hadDollar = whole.includes("$");
      const unit = m[2];
      let bareOk = false;
      if (!unit && !hadDollar && !needsUnit) {
        const rest = t.slice(end);
        // "2 or 3 apples" is a quantity range, not a price.
        bareOk = BARE_END.test(rest) && !/^\s+(?:or|and)\s+\d/i.test(rest);
      }
      const v = toUnits(m[1], unit, hadDollar, bareOk);
      if (v !== undefined) {
        caps.push(v);
        if (PER_ITEM_RE.test(t.slice(end))) perItem = true;
      }
    }
  };
  hit(LEAD_RE, false);
  hit(TRAIL_RE, true);
  if (caps.length) return { maxPrice: Math.min(...caps), hasConstraint: true, ...(perItem ? { perItem } : {}) };
  return { hasConstraint: UNPARSED_RE.test(t) || LOOSE_RE.test(t) };
}
