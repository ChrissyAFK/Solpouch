import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { toMicros, type Pouch } from "@solpouch/shared";

config({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../../../.env") });

const { ChainVaultClient } = await import("../src/vault/chain.js");
const { getMerchant } = await import("../src/merchants/index.js");

const vault = new ChainVaultClient((id) => getMerchant(id)?.payTo);
const merchant = getMerchant("mountain-market")!;
const pouch: Pouch = {
  id: `smoke-${randomBytes(2).toString("hex")}`,
  address: "",
  name: "smoke",
  balance: toMicros(5),
  spentToday: 0,
  frozen: false,
  maxPerOrder: toMicros(2),
  dailyLimit: toMicros(3),
  confirmAbove: 0,
  allowedMerchantIds: [merchant.id],
};
const short = (s: string) => s.slice(0, 12);
const order = () => randomBytes(16).toString("hex");

async function step(name: string, fn: () => Promise<unknown>) {
  try {
    const r = (await fn()) as { txSignature?: string; address?: string } | undefined;
    console.log(`${name}: ok ${short(r?.txSignature ?? r?.address ?? "")}`);
  } catch (e) {
    console.log(`${name}: ${(e as { code?: string }).code ?? "ERROR " + String((e as Error).message).slice(0, 120)}`);
  }
}

const used = order();
await step("createPouch", () => vault.createPouch({ ...pouch, balance: 0 }));
await step("topUp 5", () => vault.topUp(pouch.id, toMicros(5)));
await step("pay 1", () => vault.pay(pouch, merchant.payTo, toMicros(1), used));
await step("pay same order (expect OrderAlreadyUsed)", () => vault.pay(pouch, merchant.payTo, toMicros(1), used));
await step("pay 2.5 (expect OverPerOrderLimit)", () => vault.pay(pouch, merchant.payTo, toMicros(2.5), order()));
await step("freeze", () => vault.freeze(pouch.id));
await step("pay frozen (expect PouchFrozen)", () => vault.pay(pouch, merchant.payTo, toMicros(1), order()));
await step("unfreeze", () => vault.unfreeze(pouch.id));
await step("getBalance", async () => console.log(await vault.getBalance(pouch.id)));
