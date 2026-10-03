use anchor_lang::prelude::*;

use crate::events::{Frozen, Unfrozen};
use crate::state::*;

#[derive(Accounts)]
pub struct SetFrozen<'info> {
    pub owner: Signer<'info>,
    #[account(
        mut,
        has_one = owner,
        seeds = [b"pouch", pouch.owner.as_ref(), pouch.name.as_ref()],
        bump = pouch.bump
    )]
    pub pouch: Account<'info, Pouch>,
}

pub fn freeze_handler(ctx: Context<SetFrozen>) -> Result<()> {
    ctx.accounts.pouch.frozen = true;
    emit!(Frozen { pouch: ctx.accounts.pouch.key() });
    Ok(())
}

pub fn unfreeze_handler(ctx: Context<SetFrozen>) -> Result<()> {
    ctx.accounts.pouch.frozen = false;
    emit!(Unfrozen { pouch: ctx.accounts.pouch.key() });
    Ok(())
}
