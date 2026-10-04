// NOT RUN in the scaffold environment (no Solana/Anchor CLI available). Written against the
// design in programs/solpouch_vault; run with `anchor test` once the toolchain is installed.
import * as anchor from "@coral-xyz/anchor";
import { Program, AnchorError, BN } from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  createMint,
  createAccount,
  mintTo,
  transfer,
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
  const stranger = Keypair.generate();

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

  let mint: PublicKey;
  let ownerToken: PublicKey;
  let merchantToken: PublicKey;
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

  before(async () => {
    for (const kp of [agent, merchant, stranger]) {
      const sig = await provider.connection.requestAirdrop(kp.publicKey, 2 * LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(sig);
    }
    mint = await createMint(provider.connection, owner, owner.publicKey, null, 6);
    ownerToken = await createAccount(provider.connection, owner, mint, owner.publicKey);
    merchantToken = await createAccount(provider.connection, owner, mint, merchant.publicKey);
    strangerToken = await createAccount(provider.connection, owner, mint, stranger.publicKey);
    await mintTo(provider.connection, owner, mint, ownerToken, owner, 1_000_000_000);

    pouch = PublicKey.findProgramAddressSync(
      [Buffer.from("pouch"), owner.publicKey.toBuffer(), nameBytes(NAME)],
      program.programId
    )[0];
    vault = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), pouch.toBuffer()],
      program.programId
    )[0];
  });

  it("creates a pouch", async () => {
    await program.methods
      .createPouch(Array.from(nameBytes(NAME)), agent.publicKey, new BN(100_000), new BN(250_000), [merchant.publicKey])
      .accounts({
        owner: owner.publicKey,
        mint,
        pouch,
        vault,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    const p = await program.account.pouch.fetch(pouch);
    assert.ok(p.agent.equals(agent.publicKey));
    assert.equal(p.dailyLimit.toNumber(), 250_000);
    assert.isFalse(p.frozen);
  });


  it("owner tops up the vault", async () => {
    await program.methods
      .topUp(new BN(500_000))
      .accounts({ owner: owner.publicKey, pouch, vault, ownerToken, tokenProgram: TOKEN_PROGRAM_ID })
      .rpc();
    assert.equal(Number((await getAccount(provider.connection, vault)).amount), 500_000);
  });

  it("agent cannot top up", async () => {
    let failed = false;
    try {
      await program.methods
        .topUp(new BN(1))
        .accounts({ owner: agent.publicKey, pouch, vault, ownerToken, tokenProgram: TOKEN_PROGRAM_ID })
        .signers([agent])
        .rpc();
    } catch (e) {
      failed = true;
      assert.match(String(e), /ConstraintHasOne|Unauthorized|2001/);
    }
    assert.isTrue(failed, "expected agent top up to fail");
  });

  it("agent pays an allowed merchant", async () => {
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
  });

  it("rejects a reused order_id", async () => {
    const id = orderId(1);
    let failed = false;
    try {
      await program.methods
        .pay(new BN(1_000), id)
        .accounts(payAccounts(id))
        .signers([agent])
        .rpc();
    } catch (e) {
      failed = true;
      assert.match(String(e), /already in use/i);
    }
    assert.isTrue(failed, "expected reused order_id to fail");
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

  it("rejects a zero-amount payment", async () => {
    const id = orderId(7);
    await expectError(
      program.methods.pay(new BN(0), id).accounts(payAccounts(id)).signers([agent]).rpc(),
      "ZeroAmount"
    );
  });

  it("rejects create_pouch when the agent is an allowed merchant", async () => {
    const name2 = "badagent";
    const pouch2 = PublicKey.findProgramAddressSync(
      [Buffer.from("pouch"), owner.publicKey.toBuffer(), nameBytes(name2)],
      program.programId
    )[0];
    const vault2 = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), pouch2.toBuffer()],
      program.programId
    )[0];
    await expectError(
      program.methods
        .createPouch(Array.from(nameBytes(name2)), agent.publicKey, new BN(100_000), new BN(250_000), [
          merchant.publicKey,
          agent.publicKey,
        ])
        .accounts({
          owner: owner.publicKey,
          mint,
          pouch: pouch2,
          vault: vault2,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc(),
      "AgentIsMerchant"
    );
  });

  it("owner closes the pouch even with dust left in the vault", async () => {
    const left = (await getAccount(provider.connection, vault)).amount;
    await program.methods
      .withdraw(new BN(left.toString()))
      .accounts({ owner: owner.publicKey, pouch, vault, ownerToken, tokenProgram: TOKEN_PROGRAM_ID })
      .rpc();
    // anyone can send dust to the vault; close must still succeed and sweep it to the owner
    await transfer(provider.connection, owner, ownerToken, vault, owner, 5);
    const before = (await getAccount(provider.connection, ownerToken)).amount;
    await program.methods
      .closePouch()
      .accounts({ owner: owner.publicKey, pouch, vault, ownerToken, tokenProgram: TOKEN_PROGRAM_ID })
      .rpc();
    assert.isNull(await provider.connection.getAccountInfo(pouch));
    assert.isNull(await provider.connection.getAccountInfo(vault));
    const after = (await getAccount(provider.connection, ownerToken)).amount;
    assert.equal((after - before).toString(), "5");
  });
});
