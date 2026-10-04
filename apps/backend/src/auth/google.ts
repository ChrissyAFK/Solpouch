import { createRemoteJWKSet, jwtVerify } from "jose";

export interface GoogleUser {
  email: string;
  name: string;
  picture: string;
}

export class GoogleAuthError extends Error {
  constructor(public notConfigured = false) {
    super(notConfigured ? "Google sign-in is not configured" : "Invalid Google credential");
  }
}

const JWKS = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));

/** Verifies a Google Identity Services ID token (signature, issuer, audience, expiry, email_verified). */
export async function verifyGoogleIdToken(credential: string): Promise<GoogleUser> {
  const audience = process.env.GOOGLE_CLIENT_ID;
  if (!audience) throw new GoogleAuthError(true);
  try {
    const { payload } = await jwtVerify(credential, JWKS, {
      issuer: ["accounts.google.com", "https://accounts.google.com"],
      audience,
    });
    const email = payload.email;
    if (typeof email !== "string" || !email || payload.email_verified !== true) throw new Error("email not verified");
    return {
      email: email.toLowerCase(),
      name: typeof payload.name === "string" ? payload.name : email,
      picture: typeof payload.picture === "string" ? payload.picture : "",
    };
  } catch {
    throw new GoogleAuthError();
  }
}
