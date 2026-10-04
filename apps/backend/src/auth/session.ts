import { randomBytes } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";
import type { MiddlewareHandler } from "hono";
import type { GoogleUser } from "./google.js";
import type { Store, AuthSession } from "../store/types.js";

export type SessionUser = GoogleUser;
export type AuthEnv = { Variables: { user: SessionUser; session: AuthSession } };
export class AuthUnavailableError extends Error {}
let secret: Uint8Array | undefined;
function key(): Uint8Array {
  if (!secret) {
    let s = process.env.SESSION_SECRET;
    if (!s) {
      if (process.env.NODE_ENV === "production") throw new AuthUnavailableError("Sign-in is temporarily unavailable");
      s = randomBytes(32).toString("hex");
      console.warn("[auth] SESSION_SECRET is unset: sessions reset on restart");
    }
    if (Buffer.byteLength(s) < 32) throw new AuthUnavailableError("Sign-in is temporarily unavailable");
    secret = new TextEncoder().encode(s);
  }
  return secret;
}
const SESSION_AUD = "solpouch-session";
const VOICE_AUD = "solpouch-voice";
export async function signSession(u: SessionUser, store: Store) {
  const session: AuthSession = { id: randomBytes(32).toString("hex"), ...u, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now()+7*86400000).toISOString() };
  const token = await new SignJWT({ sid: session.id }).setProtectedHeader({ alg: "HS256" }).setSubject(u.email).setAudience(SESSION_AUD).setIssuedAt().setExpirationTime(Math.floor(Date.parse(session.expiresAt)/1000)).sign(key());
  await store.saveSession(session);
  return { token, session };
}
async function verifiedRecord(token: string, store: Store, audience: string) {
  const signingKey = key();
  let payload;
  try { ({ payload } = await jwtVerify(token, signingKey, { algorithms: ["HS256"], audience })); }
  catch { return undefined; }
  if (typeof payload.sid !== "string" || !payload.sub || (audience === VOICE_AUD ? payload.scope !== "voice" : !!payload.scope)) return undefined;
  let current;
  try { current = await store.getSession(payload.sid); }
  catch { throw new AuthUnavailableError("Your session could not be verified. Try again shortly"); }
  return current && current.email === payload.sub && Date.parse(current.expiresAt) > Date.now() ? current : undefined;
}
export const verifySession = (token: string, store: Store) => verifiedRecord(token, store, SESSION_AUD);
export async function signVoiceToken(parent: AuthSession) {
  const expiresAt = new Date(Math.min(Date.now()+15*60000, Date.parse(parent.expiresAt))).toISOString();
  const token = await new SignJWT({ scope: "voice", sid: parent.id }).setProtectedHeader({ alg: "HS256" }).setSubject(parent.email).setAudience(VOICE_AUD).setIssuedAt().setExpirationTime(Math.floor(Date.parse(expiresAt)/1000)).sign(key());
  return { token, expiresAt };
}
export async function verifyVoiceToken(token: unknown, store: Store): Promise<string | undefined> {
  if (typeof token !== "string" || !token) return undefined;
  return (await verifiedRecord(token, store, VOICE_AUD))?.email;
}
export const requireUser = (store: Store): MiddlewareHandler<AuthEnv> => async (c, next) => {
  const m = /^Bearer (.+)$/.exec(c.req.header("Authorization") ?? "");
  const current = m ? await verifySession(m[1]!, store) : undefined;
  if (!current) return c.json({ error: "sign_in_required" }, 401);
  c.set("session", current);
  c.set("user", { email: current.email, name: current.name, picture: current.picture });
  await next();
};
