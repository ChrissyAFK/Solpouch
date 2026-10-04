import { createPublicKey } from "node:crypto";
import { exportJWK, generateKeyPair, importPKCS8, SignJWT, type JWK } from "jose";
import { AuthUnavailableError } from "./session.js";

const KID = "solpouch-privy-1";
const TTL_SECONDS = 3600;
type Keys = { privateKey: CryptoKey; jwk: JWK };
let keys: Promise<Keys> | undefined;

async function load(): Promise<Keys> {
  const raw = process.env.PRIVY_JWT_PRIVATE_KEY;
  let privateKey: CryptoKey;
  let publicJwk: JWK;
  if (raw) {
    try {
      const pem = raw.replace(/\\n/g, "\n");
      privateKey = await importPKCS8(pem, "ES256");
      publicJwk = await exportJWK(createPublicKey(pem));
    } catch { throw new AuthUnavailableError("Wallet sign-in is temporarily unavailable"); }
  } else {
    if (process.env.NODE_ENV === "production") throw new AuthUnavailableError("Wallet sign-in is temporarily unavailable");
    const pair = await generateKeyPair("ES256", { extractable: true });
    privateKey = pair.privateKey;
    publicJwk = await exportJWK(pair.publicKey);
    console.warn("[auth] PRIVY_JWT_PRIVATE_KEY is unset: using an ephemeral Privy signing key");
  }
  const { kty, crv, x, y } = publicJwk;
  return { privateKey, jwk: { kty, crv, x, y, kid: KID, alg: "ES256", use: "sig" } };
}
function getKeys(): Promise<Keys> {
  if (!keys) keys = load().catch(e => { keys = undefined; throw e; });
  return keys;
}

export async function signPrivyToken(email: string): Promise<{ token: string; expiresAt: string }> {
  const { privateKey } = await getKeys();
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + TTL_SECONDS;
  const token = await new SignJWT({}).setProtectedHeader({ alg: "ES256", kid: KID, typ: "JWT" })
    .setSubject(email).setIssuer("solpouch").setAudience("privy").setIssuedAt(iat).setExpirationTime(exp).sign(privateKey);
  return { token, expiresAt: new Date(exp * 1000).toISOString() };
}

export async function privyJwks(): Promise<{ keys: JWK[] }> {
  return { keys: [(await getKeys()).jwk] };
}
