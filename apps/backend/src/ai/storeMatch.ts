/** Thrown when the online search itself could not run (provider, network or timeout), as opposed to finding nothing. */
export class SearchUnavailableError extends Error {
  constructor(message = "Online search is unavailable") {
    super(message);
    this.name = "SearchUnavailableError";
  }
}

/** Lowercase, no punctuation or apostrophes, no "the": "The McDonald's" -> "mcdonalds". */
export function normalizeStore(s: string): string {
  return s.toLowerCase().replace(/['’`]/g, "").replace(/[^a-z0-9]+/g, " ").replace(/\bthe\b/g, " ").replace(/\s+/g, " ").trim();
}

/** Whether a store name (and optional domain) plausibly is the store the user asked for. */
export function storeMatches(requested: string, name: string, domain = ""): boolean {
  const r = normalizeStore(requested);
  const n = normalizeStore(name);
  if (!r) return true;
  if (n && (n.includes(r) || r.includes(n))) return true;
  const flat = r.replace(/ /g, "");
  return !!flat && domain.toLowerCase().replace(/[^a-z0-9]/g, "").includes(flat);
}
