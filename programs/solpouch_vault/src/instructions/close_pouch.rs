use anchor_lang::prelude::*;
use anchor_spl::token::{close_account, CloseAccount, Token, TokenAccount};

use crate::errors::VaultError;
use crate::events::PouchClosed;
use crate::state::*;

#[derive(Accounts)]
pub struct ClosePouch<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        mut,
        has_one = owner,
        seeds = [b"pouch", pouch.owner.as_ref(), pouch.name.as_ref()],
        bump = pouch.bump,
        close = owner
    )]
    pub pouch: Account<'info, Pouch>,
    #[account(
        mut,
        seeds = [b"vault", pouch.key().as_ref()],
        bump = pouch.vault_bump,
        token::mint = pouch.mint
    )]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<ClosePouch>) -> Result<()> {
    require!(ctx.accounts.vault.amount == 0, VaultError::VaultNotEmpty);
    let p = &ctx.accounts.pouch;
    let seeds: &[&[u8]] = &[b"pouch", p.owner.as_ref(), p.name.as_ref(), &[p.bump]];
    close_account(CpiContext::new_with_signer(
        ctx.accounts.token_program.key(),
        CloseAccount {
            account: ctx.accounts.vault.to_account_info(),
            destination: ctx.accounts.owner.to_account_info(),
            authority: ctx.accounts.pouch.to_account_info(),
        },
        &[seeds],
    ))?;
    emit!(PouchClosed { pouch: ctx.accounts.pouch.key(), time: Clock::get()?.unix_timestamp });
    Ok(())
}
