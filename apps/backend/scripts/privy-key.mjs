// Generates an ES256 (P-256) PKCS8 PEM for PRIVY_JWT_PRIVATE_KEY. Usage: node scripts/privy-key.mjs
import { generateKeyPairSync } from "node:crypto";

const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString().trim();
console.log(`PRIVY_JWT_PRIVATE_KEY="${pem.replace(/\r?\n/g, "\\n")}"`);
