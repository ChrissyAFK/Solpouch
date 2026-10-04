use anchor_lang::prelude::*;

#[event]
pub struct PaymentMade {
    pub pouch: Pubkey,
    pub merchant: Pubkey,
    pub amount: u64,
    pub order_id: [u8; 16],
    pub time: i64,
}

#[event]
pub struct ToppedUp {
    pub pouch: Pubkey,
    pub amount: u64,
    pub time: i64,
}

#[event]
pub struct Frozen {
    pub pouch: Pubkey,
}

#[event]
pub struct Unfrozen {
    pub pouch: Pubkey,
}

#[event]
pub struct Withdrawn {
    pub pouch: Pubkey,
    pub amount: u64,
    pub time: i64,
}

#[event]
pub struct PouchCreated {
    pub pouch: Pubkey,
    pub owner: Pubkey,
    pub agent: Pubkey,
    pub mint: Pubkey,
    pub max_per_order: u64,
    pub daily_limit: u64,
    pub time: i64,
}

/// Emitted with the rules in effect after `set_rules` (unchanged fields included).
#[event]
pub struct RulesSet {
    pub pouch: Pubkey,
    pub max_per_order: u64,
    pub daily_limit: u64,
    pub merchant_count: u8,
    pub time: i64,
}

#[event]
pub struct PouchClosed {
    pub pouch: Pubkey,
    pub time: i64,
}
