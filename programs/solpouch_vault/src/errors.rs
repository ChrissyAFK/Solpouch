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
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("The agent key cannot be an allowed merchant")]
    AgentIsMerchant,
    #[msg("Duplicate merchant in the allowlist")]
    DuplicateMerchant,
}
