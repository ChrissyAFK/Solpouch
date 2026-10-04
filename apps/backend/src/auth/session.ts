import { randomBytes } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";
import type { MiddlewareHandler } from "hono";
import type { GoogleUser } from "./google.js";

export type SessionUser = GoogleUser;
export type AuthEnv = { Variables: { user: SessionUser } };

let secret: Uint8Array | undefined;
function key(): Uint8Array {
  if (!secret) {
    let s = process.env.SESSION_SECRET;
    if (!s) {
      if (process.env.NODE_ENV === "production") throw new Error("SESSION_SECRET must be set in production");
      s =randomBytes(32).toString("hex");
      console.warn("[auth] SESSION_SECRET is unset: using a random one, sessions reset on restart");
    }
    secret = new TextEncoder().encode(s);
  }
  return secret;
}

const SESSION_AUD = "solpouch-session";
const VOICE_AUD = "solpouch-voice";

export async function signSession(u: SessionUser): Promise<string> {
  return new SignJWT({ name: u.name, picture: u.picture })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(u.email)
    .setAudience(SESSION_AUD)
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(key());
}

export async function verifySession(token: string): Promise<SessionUser | undefined> {
  try {
    const { payload } = await jwtVerify(token, key(), { algorithms: ["HS256"], audience: SESSION_AUD });
    if (!payload.sub || payload.scope) return undefined;
    return {
      email: payload.sub,
      name: typeof payload.name === "string" ? payload.name : payload.sub,
      picture: typeof payload.picture === "string" ? payload.picture : "",
    };
  } catch {
    return undefined;
  }
}

export async function signVoiceToken(email: string): Promise<string> {
  return new SignJWT({ scope: "voice" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(email)
    .setAudience(VOICE_AUD)
    .setIssuedAt()
    .setExpirationTime("30m")
    .sign(key());
}

/** Returns the user's email, or undefined. */
export async function verifyVoiceToken(token: unknown): Promise<string | undefined> {
  if (typeof token !== "string" || !token) return undefined;
  try {
    const { payload } = await jwtVerify(token, key(), { algorithms: ["HS256"], audience: VOICE_AUD });
    return payload.scope === "voice" && payload.sub ? payload.sub : undefined;
  } catch {
    return undefined;
  }
}

export const requireUser: MiddlewareHandler<AuthEnv> = async (c, next) => {
  const m = /^Bearer (.+)$/.exec(c.req.header("Authorization") ?? "");
  const user = m ? await verifySession(m[1]!) : undefined;
  if (!user) return c.json({ error: "sign_in_required" }, 401);
  c.set("user", user);
  await next();
};
