use anchor_lang::prelude::*;
use anchor_spl::token::{transfer, Token, TokenAccount, Transfer};

use crate::events::Withdrawn;
use crate::state::*;

#[derive(Accounts)]
pub struct Withdraw<'info> {
    pub owner: Signer<'info>,
    #[account(
        has_one = owner,
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
    #[account(
        mut,
        token::mint = pouch.mint,
        token::authority = owner
    )]
    pub owner_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
    require!(amount > 0, crate::errors::VaultError::ZeroAmount);
    let p = &ctx.accounts.pouch;
    let seeds: &[&[u8]] = &[b"pouch", p.owner.as_ref(), p.name.as_ref(), &[p.bump]];
    transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.owner_token.to_account_info(),
                authority: ctx.accounts.pouch.to_account_info(),
            },
            &[seeds],
        ),
        amount,
    )?;
    emit!(Withdrawn { pouch: p.key(), amount, time: Clock::get()?.unix_timestamp });
    Ok(())
}
