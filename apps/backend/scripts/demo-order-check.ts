/** Read-only AI lookup check. No order is saved and no wallet transaction is signed. */
import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)), quiet: true } as Parameters<typeof config>[0]);
const { aiProvider } = await import('../src/ai/provider.js');
const { parseRequest } = await import('../src/ai/gemini.js');
const { findOnline } = await import('../src/ai/findOnline.js');
const request = process.argv.slice(2).join(' ') || "Get me a Big Mac meal from McDonald's on Uber Eats.";
const parsed = await parseRequest(request);
const result = await findOnline(parsed.items, { allowedDomains: ['ubereats.com'] });
console.log(JSON.stringify({ request, provider: aiProvider(), parsed, lookup: result,
  readyForReview: !!result && !result.fallback,
  note: !result || result.fallback ? 'No verified live lookup. Do not use fallback prices for a payment.' : 'Search estimate only. Review the CAD price before preparing the separate devnet demo checkout.' }, null, 2));
