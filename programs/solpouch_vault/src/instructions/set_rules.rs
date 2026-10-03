use anchor_lang::prelude::*;

use crate::errors::VaultError;
use crate::state::*;

#[derive(Accounts)]
pub struct SetRules<'info> {
    pub owner: Signer<'info>,
    #[account(
        mut,
        has_one = owner,
        seeds = [b"pouch", pouch.owner.as_ref(), pouch.name.as_ref()],
        bump = pouch.bump
    )]
    pub pouch: Account<'info, Pouch>,
}

pub fn handler(
    ctx: Context<SetRules>,
    agent: Option<Pubkey>,
    max_per_order: Option<u64>,
    daily_limit: Option<u64>,
    allowed_merchants: Option<Vec<Pubkey>>,
) -> Result<()> {
    let p = &mut ctx.accounts.pouch;
    if let Some(a) = agent {
        p.agent = a;
    }
    if let Some(v) = max_per_order {
        p.max_per_order = v;
    }
    if let Some(v) = daily_limit {
        p.daily_limit = v;
    }
    if let Some(m) = allowed_merchants {
        require!(m.len() <= MAX_MERCHANTS, VaultError::TooManyMerchants);
        p.allowed_merchants = m;
    }
    Ok(())
}
