import type { Store } from "../store/types.js";
import { getMerchant } from "../merchants/index.js";
import { ChainVaultClient } from "./chain.js";
import { MockVaultClient } from "./mock.js";
import type { VaultClient } from "./types.js";

export function createVaultClient(store: Store): VaultClient {
  const mode = process.env.VAULT_MODE ?? "mock";
  if (mode === "chain") return new ChainVaultClient((id) => getMerchant(id)?.payTo);
  return new MockVaultClient(store, (id) => getMerchant(id)?.payTo);
}

export { ensureOnChain, ChainVaultClient } from "./chain.js";
