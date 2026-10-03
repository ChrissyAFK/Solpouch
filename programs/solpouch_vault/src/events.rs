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
}
