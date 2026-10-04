import { createPublicKey, verify } from "node:crypto";
import { PublicKey } from "@solana/web3.js";

/** A canonical base58 ed25519 public key that is on the curve (a wallet, not a program address). */
export function validWallet(wallet: string): boolean {
  try { const key = new PublicKey(wallet); return key.toBase58() === wallet && PublicKey.isOnCurve(key.toBytes()); } catch { return false; }
}
/** Checks a base64 ed25519 signature of `message` (UTF-8, as wallets sign it) by `wallet`. */
export function validSignature(wallet: string, message: string, signature: string): boolean {
  try {
    if (!/^[A-Za-z0-9+/]{86}==$/.test(signature)) return false;
    const key = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), new PublicKey(wallet).toBuffer()]), format: "der", type: "spki" });
    return verify(null, Buffer.from(message), key, Buffer.from(signature, "base64"));
  } catch { return false; }
}
