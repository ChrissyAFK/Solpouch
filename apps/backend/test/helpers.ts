import { signSession, signVoiceToken } from "../src/auth/session.js";
import { seedPouches } from "../src/store/memory.js";

process.env.SESSION_SECRET ||= "test-session-secret-test-session-secret";

export const TEST_USER = "tester@example.com";

/** Seed pouches owned by `email`. */
export const ownedSeed = (email = TEST_USER) => seedPouches().map((p) => ({ ...p, ownerEmail: email }));

export async function sessionToken(store: import("../src/store/types.js").Store, email = TEST_USER) {
  return (await signSession({ email, name: "Test User", picture: "" }, store)).token;
}
export async function authHeaders(store: import("../src/store/types.js").Store, email = TEST_USER): Promise<Record<string, string>> {
  return { Authorization: `Bearer ${await sessionToken(store, email)}` };
}
export async function voiceToken(store: import("../src/store/types.js").Store, email = TEST_USER) {
  const {session} = await signSession({ email, name: "Test User", picture: "" }, store);
  return (await signVoiceToken(session)).token;
}
