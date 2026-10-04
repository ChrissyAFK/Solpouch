import { signSession, signVoiceToken } from "../src/auth/session.js";
import { seedPouches } from "../src/store/memory.js";

process.env.SESSION_SECRET ||= "test-session-secret-test-session-secret";

export const TEST_USER = "tester@example.com";

/** Seed pouches owned by `email`. */
export const ownedSeed = (email = TEST_USER) => seedPouches().map((p) => ({ ...p, ownerEmail: email }));

export async function sessionToken(email = TEST_USER) {
  return signSession({ email, name: "Test User", picture: "" });
}
export async function authHeaders(email = TEST_USER): Promise<Record<string, string>> {
  return { Authorization: `Bearer ${await sessionToken(email)}` };
}
export const voiceToken = (email = TEST_USER) => signVoiceToken(email);
