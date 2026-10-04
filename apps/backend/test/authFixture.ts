import { Keypair } from "@solana/web3.js";
import { MemoryStore, seedPouches } from "../src/store/memory.js";
import { hashToken } from "../src/security/auth.js";

// Explicit test-only credentials and balances; never used by application startup.
export const TEST_WALLET = Keypair.fromSeed(new Uint8Array(32).fill(7)).publicKey.toBase58();
export const WEB_TOKEN = Buffer.alloc(32, 11).toString("base64url");
export const VOICE_TOKEN = Buffer.alloc(32, 12).toString("base64url");
export const VOICE_SECRET = "fixture-only-voice-secret";
export const webHeaders = { Authorization: `Bearer ${WEB_TOKEN}` };
export const voiceHeaders = { Authorization: `Bearer ${VOICE_TOKEN}`, "X-Solpouch-Secret": VOICE_SECRET };
export async function authenticatedStore() {
  const store = new MemoryStore(seedPouches().map((pouch) => ({ ...pouch, ownerWallet: TEST_WALLET })));
  for (const [token, scope] of [[WEB_TOKEN, "web"], [VOICE_TOKEN, "voice"]] as const) {
    await store.saveSession({ tokenHash: hashToken(token), wallet: TEST_WALLET, scope, ...(scope === "voice" ? { parentTokenHash: hashToken(WEB_TOKEN) } : {}), expiresAt: new Date(Date.now() + 3600_000).toISOString() });
  }
  return store;
}
