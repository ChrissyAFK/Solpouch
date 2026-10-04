use anchor_lang::prelude::*;
use anchor_spl::token::{transfer, Token, TokenAccount, Transfer};

use crate::errors::VaultError;
use crate::events::PaymentMade;
use crate::logic::{check_pay, PayState};
use crate::state::*;

/// Associated Token Account program.
const ATA_PROGRAM_ID: Pubkey = pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

/// Canonical associated token account of `wallet` for `mint` under the classic Token program.
fn associated_token_address(wallet: &Pubkey, mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[wallet.as_ref(), anchor_spl::token::ID.as_ref(), mint.as_ref()],
        &ATA_PROGRAM_ID,
    )
    .0
}

#[derive(Accounts)]
#[instruction(amount: u64, order_id: [u8; 16])]
pub struct Pay<'info> {
    #[account(mut)]
    pub agent: Signer<'info>,
    #[account(
        mut,
        has_one = agent,
        seeds = [b"pouch", pouch.owner.as_ref(), pouch.name.as_ref()],
        bump = pouch.bump
    )]
    pub pouch: Account<'info, Pouch>,
    #[account(
        mut,
        seeds = [b"vault", pouch.key().as_ref()],
        bump = pouch.vault_bump,
        token::mint = pouch.mint
    )]
    pub vault: Account<'info, TokenAccount>,
    /// Must be the canonical ATA of an allowlisted merchant (checked in the handler).
    #[account(mut, token::mint = pouch.mint)]
    pub merchant_token: Account<'info, TokenAccount>,
    #[account(
        init,
        payer = agent,
        space = 8 + Receipt::INIT_SPACE,
        seeds = [b"receipt", pouch.key().as_ref(), order_id.as_ref()],
        bump
    )]
    pub receipt: Account<'info, Receipt>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<Pay>, amount: u64, order_id: [u8; 16]) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let merchant = ctx.accounts.merchant_token.owner;
    let p = &ctx.accounts.pouch;
    let (spent, day_start) = check_pay(
        &PayState {
            frozen: p.frozen,
            allowed_merchants: &p.allowed_merchants,
            max_per_order: p.max_per_order,
            daily_limit: p.daily_limit,
            spent_today: p.spent_today,
            day_start: p.day_start,
        },
        &merchant,
        amount,
        ctx.accounts.vault.amount,
        now,
    )?;
    // The allowlist is checked by token owner above; also pin the destination to that owner's
    // canonical ATA so funds cannot land in a stray or delegated token account.
    require_keys_eq!(
        ctx.accounts.merchant_token.key(),
        associated_token_address(&merchant, &p.mint),
        VaultError::MerchantTokenNotAta
    );

    let seeds: &[&[u8]] = &[b"pouch", p.owner.as_ref(), p.name.as_ref(), &[p.bump]];
    transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.merchant_token.to_account_info(),
                authority: ctx.accounts.pouch.to_account_info(),
            },
            &[seeds],
        ),
        amount,
    )?;

    let pouch_key = ctx.accounts.pouch.key();
    let p = &mut ctx.accounts.pouch;
    p.spent_today = spent;
    p.day_start = day_start;

    let r = &mut ctx.accounts.receipt;
    r.pouch = pouch_key;
    r.merchant = merchant;
    r.amount = amount;
    r.time = now;
    r.order_id = order_id;

    emit!(PaymentMade { pouch: pouch_key, merchant, amount, order_id, time: now });
    Ok(())
}
