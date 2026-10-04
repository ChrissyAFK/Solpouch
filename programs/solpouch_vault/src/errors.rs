use anchor_lang::prelude::*;

#[error_code]
#[derive(PartialEq, Eq)]
pub enum VaultError {
    #[msg("Signer is not authorized")]
    Unauthorized,
    #[msg("Pouch is frozen")]
    PouchFrozen,
    #[msg("Merchant is not on the allowlist")]
    MerchantNotAllowed,
    #[msg("Amount exceeds the per-order limit")]
    OverPerOrderLimit,
    #[msg("Amount exceeds the daily limit")]
    OverDailyLimit,
    #[msg("Vault balance is too low")]
    InsufficientFunds,
    #[msg("Pouch name is longer than 32 bytes")]
    NameTooLong,
    #[msg("Too many allowed merchants (max 10)")]
    TooManyMerchants,
    #[msg("Vault must be empty to close the pouch")]
    VaultNotEmpty,
    // New variants go at the end so existing codes 6000-6008 stay stable.
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Per-order and daily limits must be greater than zero")]
    ZeroLimit,
    #[msg("Per-order limit exceeds the daily limit")]
    PerOrderOverDaily,
    #[msg("Agent key must differ from the owner")]
    AgentIsOwner,
    #[msg("Allowed merchants contain a duplicate")]
    DuplicateMerchant,
    #[msg("Merchant token account is not the merchant's associated token account")]
    MerchantTokenNotAta,
}
