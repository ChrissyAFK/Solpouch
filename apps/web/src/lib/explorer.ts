// Solana transaction signatures are base58, 86 to 88 characters. Mock vaults
// return synthetic strings that fail this check, so they get no Explorer link.
const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{86,88}$/;

export const isRealSignature = (sig: string | null | undefined): sig is string =>
  typeof sig === "string" && SIGNATURE.test(sig);

export const explorerTxUrl = (sig: string | null | undefined): string | null =>
  isRealSignature(sig)
    ? `https://explorer.solana.com/tx/${encodeURIComponent(sig)}?cluster=devnet`
    : null;
