use anchor_lang::prelude::*;

use crate::events::RulesSet;
use crate::logic::check_rules;
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
    let pouch_key = ctx.accounts.pouch.key();
    let p = &mut ctx.accounts.pouch;
    if let Some(a) = agent {
        p.agent = a;
    }
    if let Some(v) = max_per_order {
        p.max_per_order = v;
    }
    if let Some(v) = daily_limit {
        // May drop below spent_today; pay then refuses until the 24h window resets (see logic.rs).
        p.daily_limit = v;
    }
    if let Some(m) = allowed_merchants {
        p.allowed_merchants = m;
    }
    // Validate the merged rules; any error aborts the transaction, so nothing above persists.
    check_rules(&p.owner, &p.agent, p.max_per_order, p.daily_limit, &p.allowed_merchants)?;
    emit!(RulesSet {
        pouch: pouch_key,
        max_per_order: p.max_per_order,
        daily_limit: p.daily_limit,
        merchant_count: p.allowed_merchants.len() as u8,
        time: Clock::get()?.unix_timestamp,
    });
    Ok(())
}
