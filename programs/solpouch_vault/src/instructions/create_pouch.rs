use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::events::PouchCreated;
use crate::logic::check_rules;
use crate::state::*;

#[derive(Accounts)]
#[instruction(name: [u8; NAME_LEN])]
pub struct CreatePouch<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    pub mint: Account<'info, Mint>,
    #[account(
        init,
        payer = owner,
        space = 8 + Pouch::INIT_SPACE,
        seeds = [b"pouch", owner.key().as_ref(), name.as_ref()],
        bump
    )]
    pub pouch: Account<'info, Pouch>,
    #[account(
        init,
        payer = owner,
        seeds = [b"vault", pouch.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = pouch
    )]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<CreatePouch>,
    name: [u8; NAME_LEN],
    agent: Pubkey,
    max_per_order: u64,
    daily_limit: u64,
    allowed_merchants: Vec<Pubkey>,
) -> Result<()> {
    let owner = ctx.accounts.owner.key();
    check_rules(&owner, &agent, max_per_order, daily_limit, &allowed_merchants)?;
    let now = Clock::get()?.unix_timestamp;
    let pouch_key = ctx.accounts.pouch.key();
    let mint = ctx.accounts.mint.key();
    let p = &mut ctx.accounts.pouch;
    p.owner = owner;
    p.agent = agent;
    p.mint = mint;
    p.name = name;
    p.allowed_merchants = allowed_merchants;
    p.max_per_order = max_per_order;
    p.daily_limit = daily_limit;
    p.spent_today = 0;
    p.day_start = now;
    p.frozen = false;
    p.bump = ctx.bumps.pouch;
    p.vault_bump = ctx.bumps.vault;
    emit!(PouchCreated { pouch: pouch_key, owner, agent, mint, max_per_order, daily_limit, time: now });
    Ok(())
}
