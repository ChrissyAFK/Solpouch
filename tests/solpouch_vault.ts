// Run with `anchor test` (Anchor.toml targets localnet; it never deploys to devnet).
import * as anchor from "@coral-xyz/anchor";
import { Program, AnchorError, BN } from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  createMint,
  createAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { assert } from "chai";
import { SolpouchVault } from "../target/types/solpouch_vault";

describe("solpouch_vault", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.solpouchVault as Program<SolpouchVault>;
  const owner = (provider.wallet as anchor.Wallet).payer;
  const agent = Keypair.generate();
  const merchant = Keypair.generate();
  const merchant2 = Keypair.generate();
  const stranger = Keypair.generate();
  const eventParser = new anchor.EventParser(program.programId, new anchor.BorshCoder(program.idl));

  const nameBytes = (s: string) => {
    const b = Buffer.alloc(32);
    b.write(s);
    return b;
  };
  const orderId = (n: number) => {
    const b = Buffer.alloc(16);
    b.writeUInt32LE(n);
    return Array.from(b);
  };
  const pdas = (name: string) => {
    const p = PublicKey.findProgramAddressSync(
      [Buffer.from("pouch"), owner.publicKey.toBuffer(), nameBytes(name)],
      program.programId
    )[0];
    const v = PublicKey.findProgramAddressSync([Buffer.from("vault"), p.toBuffer()], program.programId)[0];
    return { pouch: p, vault: v };
  };

  let mint: PublicKey;
  let ownerToken: PublicKey;
  let merchantToken: PublicKey;
  let merchantNonAta: PublicKey;
  let strangerToken: PublicKey;
  let pouch: PublicKey;
  let vault: PublicKey;

  const NAME = "groceries";
  const receiptPda = (id: number[]) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("receipt"), pouch.toBuffer(), Buffer.from(id)],
      program.programId
    )[0];

  const payAccounts = (id: number[], dest = merchantToken) => ({
    agent: agent.publicKey,
    pouch,
    vault,
    merchantToken: dest,
    receipt: receiptPda(id),
    tokenProgram: TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
  });

  const createPouch = (name: string, agentKey: PublicKey, max: number, daily: number, merchants: PublicKey[]) => {
    const { pouch: p, vault: v } = pdas(name);
    return program.methods
      .createPouch(Array.from(nameBytes(name)), agentKey, new BN(max), new BN(daily), merchants)
      .accountsPartial({
        owner: owner.publicKey,
        mint,
        pouch: p,
        vault: v,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      });
  };

  const expectError = async (p: Promise<unknown>, code: string) => {
    try {
      await p;
    } catch (e) {
      const err = e as AnchorError;
      assert.equal(err.error?.errorCode?.code ?? String(e), code);
      return;
    }
    assert.fail(`expected ${code}`);
  };

  const eventsOf = async (sig: string) => {
    await provider.connection.confirmTransaction(sig, "confirmed");
    const tx = await provider.connection.getTransaction(sig, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    return [...eventParser.parseLogs(tx?.meta?.logMessages ?? [])];
  };

  before(async () => {
    for (const kp of [agent, merchant, stranger]) {
      const sig = await provider.connection.requestAirdrop(kp.publicKey, 2 * LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(sig);
    }
    mint = await createMint(provider.connection, owner, owner.publicKey, null, 6);
    ownerToken = await createAccount(provider.connection, owner, mint, owner.publicKey);
    // Without a keypair argument createAccount creates the canonical associated token account.
    merchantToken = await createAccount(provider.connection, owner, mint, merchant.publicKey);
    strangerToken = await createAccount(provider.connection, owner, mint, stranger.publicKey);
    // A token account owned by the allowlisted merchant, but not its ATA.
    merchantNonAta = await createAccount(provider.connection, owner, mint, merchant.publicKey, Keypair.generate());
    await mintTo(provider.connection, owner, mint, ownerToken, owner, 1_000_000_000);

    ({ pouch, vault } = pdas(NAME));
  });

  it("creates a pouch and emits PouchCreated", async () => {
    const sig = await createPouch(NAME, agent.publicKey, 100_000, 250_000, [merchant.publicKey]).rpc();
    const p = await program.account.pouch.fetch(pouch);
    assert.ok(p.agent.equals(agent.publicKey));
    assert.equal(p.dailyLimit.toNumber(), 250_000);
    assert.isFalse(p.frozen);

    const ev = (await eventsOf(sig)).find((e) => e.name === "pouchCreated");
    assert.ok(ev, "PouchCreated not emitted");
    assert.ok(ev!.data.pouch.equals(pouch));
    assert.ok(ev!.data.owner.equals(owner.publicKey));
    assert.ok(ev!.data.agent.equals(agent.publicKey));
    assert.ok(ev!.data.mint.equals(mint));
    assert.equal(ev!.data.maxPerOrder.toNumber(), 100_000);
    assert.equal(ev!.data.dailyLimit.toNumber(), 250_000);
    assert.isAbove(ev!.data.time.toNumber(), 0);
  });

  it("rejects invalid rules at create", async () => {
    await expectError(createPouch("bad-max", agent.publicKey, 300, 200, []).rpc(), "PerOrderOverDaily");
    await expectError(createPouch("bad-zero", agent.publicKey, 0, 200, []).rpc(), "ZeroLimit");
    await expectError(createPouch("bad-agent", owner.publicKey, 100, 200, []).rpc(), "AgentIsOwner");
    await expectError(
      createPouch("bad-dup", agent.publicKey, 100, 200, [merchant.publicKey, merchant.publicKey]).rpc(),
      "DuplicateMerchant"
    );
    assert.isNull(await provider.connection.getAccountInfo(pdas("bad-max").pouch));
  });

  it("owner tops up the vault", async () => {
    await program.methods
      .topUp(new BN(500_000))
      .accounts({ owner: owner.publicKey, pouch, vault, ownerToken, tokenProgram: TOKEN_PROGRAM_ID })
      .rpc();
    assert.equal(Number((await getAccount(provider.connection, vault)).amount), 500_000);
  });

  it("agent cannot top up", async () => {
    await expectError(
      program.methods
        .topUp(new BN(1))
        .accounts({ owner: agent.publicKey, pouch, vault, ownerToken, tokenProgram: TOKEN_PROGRAM_ID })
        .signers([agent])
        .rpc(),
      "ConstraintHasOne"
    );
  });

  it("agent cannot set_rules, withdraw or freeze", async () => {
    await expectError(
      program.methods
        .setRules(null, null, new BN(10_000_000), null)
        .accounts({ owner: agent.publicKey, pouch })
        .signers([agent])
        .rpc(),
      "ConstraintHasOne"
    );
    await expectError(
      program.methods
        .withdraw(new BN(1))
        .accounts({ owner: agent.publicKey, pouch, vault, ownerToken, tokenProgram: TOKEN_PROGRAM_ID })
        .signers([agent])
        .rpc(),
      "ConstraintHasOne"
    );
    await expectError(
      program.methods.freeze().accounts({ owner: agent.publicKey, pouch }).signers([agent]).rpc(),
      "ConstraintHasOne"
    );
  });

  it("set_rules rejects invalid merged rules and keeps the old ones", async () => {
    await expectError(
      program.methods.setRules(null, new BN(300_000), null, null).accounts({ owner: owner.publicKey, pouch }).rpc(),
      "PerOrderOverDaily"
    );
    await expectError(
      program.methods
        .setRules(null, null, null, [merchant.publicKey, merchant.publicKey])
        .accounts({ owner: owner.publicKey, pouch })
        .rpc(),
      "DuplicateMerchant"
    );
    await expectError(
      program.methods.setRules(owner.publicKey, null, null, null).accounts({ owner: owner.publicKey, pouch }).rpc(),
      "AgentIsOwner"
    );
    const p = await program.account.pouch.fetch(pouch);
    assert.equal(p.maxPerOrder.toNumber(), 100_000);
    assert.equal(p.allowedMerchants.length, 1);
    assert.ok(p.agent.equals(agent.publicKey));
  });

  it("set_rules emits RulesSet with the merged rules", async () => {
    const sig = await program.methods
      .setRules(null, null, null, [merchant.publicKey, merchant2.publicKey])
      .accounts({ owner: owner.publicKey, pouch })
      .rpc();
    const ev = (await eventsOf(sig)).find((e) => e.name === "rulesSet");
    assert.ok(ev, "RulesSet not emitted");
    assert.equal(ev!.data.maxPerOrder.toNumber(), 100_000);
    assert.equal(ev!.data.dailyLimit.toNumber(), 250_000);
    assert.equal(ev!.data.merchantCount, 2);
  });

  it("agent pays an allowed merchant and the receipt stores order_id", async () => {
    const id = orderId(1);
    await program.methods
      .pay(new BN(100_000), id)
      .accounts(payAccounts(id))
      .signers([agent])
      .rpc();
    assert.equal(Number((await getAccount(provider.connection, merchantToken)).amount), 100_000);
    const r = await program.account.receipt.fetch(receiptPda(id));
    assert.equal(r.amount.toNumber(), 100_000);
    assert.ok(r.merchant.equals(merchant.publicKey));
    assert.ok(r.pouch.equals(pouch));
    assert.deepEqual(Array.from(r.orderId), id);
  });

  it("rejects a reused order_id", async () => {
    const id = orderId(1);
    try {
      await program.methods
        .pay(new BN(1_000), id)
        .accounts(payAccounts(id))
        .signers([agent])
        .rpc();
      assert.fail("expected failure");
    } catch (e) {
      // The receipt PDA already exists, so the System Program's create_account fails with
      // SystemError::AccountAlreadyInUse (custom error 0).
      const logs = ((e as { logs?: string[] }).logs ?? []).join("\n");
      assert.include(logs, "already in use");
      assert.include(String(e), "custom program error: 0x0");
    }
  });

  it("rejects a zero amount", async () => {
    const id = orderId(7);
    await expectError(
      program.methods.pay(new BN(0), id).accounts(payAccounts(id)).signers([agent]).rpc(),
      "ZeroAmount"
    );
  });

  it("rejects a merchant token account that is not the merchant's ATA", async () => {
    const id = orderId(8);
    await expectError(
      program.methods
        .pay(new BN(1_000), id)
        .accounts(payAccounts(id, merchantNonAta))
        .signers([agent])
        .rpc(),
      "MerchantTokenNotAta"
    );
  });

  it("rejects over the per-order limit", async () => {
    const id = orderId(2);
    await expectError(
      program.methods.pay(new BN(100_001), id).accounts(payAccounts(id)).signers([agent]).rpc(),
      "OverPerOrderLimit"
    );
  });

  it("rejects over the daily limit", async () => {
    // spent 100k so far, limit 250k: 100k more is fine, the next 100k is not
    const id2 = orderId(3);
    await program.methods.pay(new BN(100_000), id2).accounts(payAccounts(id2)).signers([agent]).rpc();
    const id3 = orderId(4);
    await expectError(
      program.methods.pay(new BN(100_000), id3).accounts(payAccounts(id3)).signers([agent]).rpc(),
      "OverDailyLimit"
    );
  });

  it("rejects a non-allowlisted merchant", async () => {
    const id = orderId(5);
    await expectError(
      program.methods
        .pay(new BN(1_000), id)
        .accounts(payAccounts(id, strangerToken))
        .signers([agent])
        .rpc(),
      "MerchantNotAllowed"
    );
  });

  it("rejects payments while frozen, accepts after unfreeze", async () => {
    await program.methods.freeze().accounts({ owner: owner.publicKey, pouch }).rpc();
    const id = orderId(6);
    await expectError(
      program.methods.pay(new BN(1_000), id).accounts(payAccounts(id)).signers([agent]).rpc(),
      "PouchFrozen"
    );
    await program.methods.unfreeze().accounts({ owner: owner.publicKey, pouch }).rpc();
    await program.methods.pay(new BN(1_000), id).accounts(payAccounts(id)).signers([agent]).rpc();
  });

  it("cannot close a pouch with a non-empty vault", async () => {
    await expectError(
      program.methods
        .closePouch()
        .accounts({ owner: owner.publicKey, pouch, vault, tokenProgram: TOKEN_PROGRAM_ID })
        .rpc(),
      "VaultNotEmpty"
    );
    assert.isNotNull(await provider.connection.getAccountInfo(pouch));
  });

  it("owner withdraws and closes the pouch", async () => {
    const left = (await getAccount(provider.connection, vault)).amount;
    await program.methods
      .withdraw(new BN(left.toString()))
      .accounts({ owner: owner.publicKey, pouch, vault, ownerToken, tokenProgram: TOKEN_PROGRAM_ID })
      .rpc();
    const sig = await program.methods
      .closePouch()
      .accounts({ owner: owner.publicKey, pouch, vault, tokenProgram: TOKEN_PROGRAM_ID })
      .rpc();
    assert.isNull(await provider.connection.getAccountInfo(pouch));
    const ev = (await eventsOf(sig)).find((e) => e.name === "pouchClosed");
    assert.ok(ev && ev.data.pouch.equals(pouch), "PouchClosed not emitted");
  });
});
