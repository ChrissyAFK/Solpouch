use anchor_lang::prelude::*;

pub mod errors;
pub mod events;
pub mod instructions;
pub mod logic;
pub mod state;

use instructions::*;

// Placeholder id; `anchor keys sync` replaces it.
declare_id!("AqixXTfd8n914z7QCsNmBuZcFbDsitbGrBfCHStmJT8F");

#[program]
pub mod solpouch_vault {
    use super::*;

    pub fn create_pouch(
        ctx: Context<CreatePouch>,
        // UTF-8 name, zero-padded to 32 bytes by the client (it is also a PDA seed).
        name: [u8; 32],
        agent: Pubkey,
        max_per_order: u64,
        daily_limit: u64,
        allowed_merchants: Vec<Pubkey>,
    ) -> Result<()> {
        instructions::create_pouch::handler(ctx, name, agent, max_per_order, daily_limit, allowed_merchants)
    }

    pub fn top_up(ctx: Context<TopUp>, amount: u64) -> Result<()> {
        instructions::top_up::handler(ctx, amount)
    }

    pub fn pay(ctx: Context<Pay>, amount: u64, order_id: [u8; 16]) -> Result<()> {
        instructions::pay::handler(ctx, amount, order_id)
    }

    pub fn set_rules(
        ctx: Context<SetRules>,
        agent: Option<Pubkey>,
        max_per_order: Option<u64>,
        daily_limit: Option<u64>,
        allowed_merchants: Option<Vec<Pubkey>>,
    ) -> Result<()> {
        instructions::set_rules::handler(ctx, agent, max_per_order, daily_limit, allowed_merchants)
    }

    pub fn freeze(ctx: Context<SetFrozen>) -> Result<()> {
        instructions::freeze::freeze_handler(ctx)
    }

    pub fn unfreeze(ctx: Context<SetFrozen>) -> Result<()> {
        instructions::freeze::unfreeze_handler(ctx)
    }

    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        instructions::withdraw::handler(ctx, amount)
    }

    pub fn close_pouch(ctx: Context<ClosePouch>) -> Result<()> {
        instructions::close_pouch::handler(ctx)
    }
}
