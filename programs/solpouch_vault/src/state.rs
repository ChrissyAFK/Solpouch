use anchor_lang::prelude::*;

pub const MAX_MERCHANTS: usize = 10;
pub const NAME_LEN: usize = 32;

#[account]
#[derive(InitSpace)]
pub struct Pouch {
    pub owner: Pubkey,
    pub agent: Pubkey,
    pub mint: Pubkey,
    pub name: [u8; NAME_LEN],
    #[max_len(10)]
    pub allowed_merchants: Vec<Pubkey>,
    pub max_per_order: u64,
    pub daily_limit: u64,
    pub spent_today: u64,
    pub day_start: i64,
    pub frozen: bool,
    pub bump: u8,
    pub vault_bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Receipt {
    pub pouch: Pubkey,
    pub merchant: Pubkey,
    pub amount: u64,
    pub time: i64,
}

/// Zero-pads a name to 32 bytes; longer names are truncated here and rejected by the handler.
pub fn pad_name(name: &str) -> [u8; NAME_LEN] {
    let mut out = [0u8; NAME_LEN];
    let b = name.as_bytes();
    let n = b.len().min(NAME_LEN);
    out[..n].copy_from_slice(&b[..n]);
    out
}
