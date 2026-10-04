//! Pure rule checks, kept free of account plumbing so they can be unit tested.
//!
//! Daily limit semantics: the limit applies to a rolling 24-hour window, not a calendar day.
//! A window opens at `day_start` (pouch creation, or the first payment after the previous
//! window expired) and lasts `DAY_SECONDS`. Payments inside the window accumulate in
//! `spent_today`; the first payment at or after `day_start + DAY_SECONDS` resets the counter
//! and opens a new window at that payment's time.
//!
//! `set_rules` may lower `daily_limit` below the current `spent_today`. That is allowed on
//! purpose: the owner can tighten a pouch at any time, and `check_pay` simply refuses further
//! payments until the window resets.

use crate::errors::VaultError;
use crate::state::MAX_MERCHANTS;
use anchor_lang::prelude::Pubkey;

pub const DAY_SECONDS: i64 = 86_400;

/// Validates pouch rules for `create_pouch` and (after merging updates) `set_rules`.
pub fn check_rules(
    owner: &Pubkey,
    agent: &Pubkey,
    max_per_order: u64,
    daily_limit: u64,
    merchants: &[Pubkey],
) -> Result<(), VaultError> {
    if merchants.len() > MAX_MERCHANTS {
        return Err(VaultError::TooManyMerchants);
    }
    if max_per_order == 0 || daily_limit == 0 {
        return Err(VaultError::ZeroLimit);
    }
    if max_per_order > daily_limit {
        return Err(VaultError::PerOrderOverDaily);
    }
    if agent == owner {
        return Err(VaultError::AgentIsOwner);
    }
    for (i, m) in merchants.iter().enumerate() {
        if m == agent {
            return Err(VaultError::AgentIsMerchant);
        }
        if merchants[..i].contains(m) {
            return Err(VaultError::DuplicateMerchant);
        }
    }
    Ok(())
}

pub struct PayState<'a> {
    pub agent: Pubkey,
    pub frozen: bool,
    pub allowed_merchants: &'a [Pubkey],
    pub max_per_order: u64,
    pub daily_limit: u64,
    pub spent_today: u64,
    pub day_start: i64,
}

/// Validates a payment. Returns the new `(spent_today, day_start)`.
pub fn check_pay(
    s: &PayState,
    merchant: &Pubkey,
    amount: u64,
    vault_balance: u64,
    now: i64,
) -> Result<(u64, i64), VaultError> {
    if amount == 0 {
        return Err(VaultError::ZeroAmount);
    }
    if s.frozen {
        return Err(VaultError::PouchFrozen);
    }
    if *merchant == s.agent {
        return Err(VaultError::AgentIsMerchant);
    }
    if !s.allowed_merchants.contains(merchant) {
        return Err(VaultError::MerchantNotAllowed);
    }
    if amount > s.max_per_order {
        return Err(VaultError::OverPerOrderLimit);
    }
    let (mut spent, mut day_start) = (s.spent_today, s.day_start);
    if now.saturating_sub(day_start) >= DAY_SECONDS {
        spent = 0;
        day_start = now;
    }
    let new_spent = spent.checked_add(amount).ok_or(VaultError::OverDailyLimit)?;
    if new_spent > s.daily_limit {
        return Err(VaultError::OverDailyLimit);
    }
    if amount > vault_balance {
        return Err(VaultError::InsufficientFunds);
    }
    Ok((new_spent, day_start))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rules_agent_is_merchant() {
        assert_eq!(
            check_rules(&k(1), &k(2), 10, 100, &[k(3), k(2)]),
            Err(VaultError::AgentIsMerchant)
        );
    }

    fn m() -> Pubkey {
        Pubkey::new_from_array([7; 32])
    }

    fn state(allowed: &[Pubkey]) -> PayState<'_> {
        PayState {
            agent: Pubkey::new_from_array([1; 32]),
            frozen: false,
            allowed_merchants: allowed,
            max_per_order: 100,
            daily_limit: 250,
            spent_today: 0,
            day_start: 1_000,
        }
    }

    #[test]
    fn happy_path() {
        let a = [m()];
        assert_eq!(check_pay(&state(&a), &m(), 50, 1_000, 1_100), Ok((50, 1_000)));
    }

    #[test]
    fn pay_rejects_agent_as_merchant() {
        let agent = Pubkey::new_from_array([1; 32]);
        let a = [m(), agent];
        assert_eq!(check_pay(&state(&a), &agent, 1, 10, 1_100), Err(VaultError::AgentIsMerchant));
    }

    #[test]
    fn frozen() {
        let a = [m()];
        let mut s = state(&a);
        s.frozen = true;
        assert_eq!(check_pay(&s, &m(), 1, 10, 1_100), Err(VaultError::PouchFrozen));
    }

    #[test]
    fn merchant_not_allowed() {
        let a = [Pubkey::new_from_array([9; 32])];
        assert_eq!(check_pay(&state(&a), &m(), 1, 10, 1_100), Err(VaultError::MerchantNotAllowed));
        assert_eq!(check_pay(&state(&[]), &m(), 1, 10, 1_100), Err(VaultError::MerchantNotAllowed));
    }

    #[test]
    fn per_order_limit_boundary() {
        let a = [m()];
        assert!(check_pay(&state(&a), &m(), 100, 1_000, 1_100).is_ok());
        assert_eq!(check_pay(&state(&a), &m(), 101, 1_000, 1_100), Err(VaultError::OverPerOrderLimit));
    }

    #[test]
    fn daily_limit_boundary() {
        let a = [m()];
        let mut s = state(&a);
        s.spent_today = 150;
        assert_eq!(check_pay(&s, &m(), 100, 1_000, 1_100), Ok((250, 1_000)));
        s.spent_today = 151;
        assert_eq!(check_pay(&s, &m(), 100, 1_000, 1_100), Err(VaultError::OverDailyLimit));
    }

    #[test]
    fn day_rollover_resets() {
        let a = [m()];
        let mut s = state(&a);
        s.spent_today = 250;
        assert_eq!(
            check_pay(&s, &m(), 100, 1_000, 1_000 + DAY_SECONDS - 1),
            Err(VaultError::OverDailyLimit)
        );
        assert_eq!(
            check_pay(&s, &m(), 100, 1_000, 1_000 + DAY_SECONDS),
            Ok((100, 1_000 + DAY_SECONDS))
        );
    }

    #[test]
    fn insufficient_funds() {
        let a = [m()];
        assert_eq!(check_pay(&state(&a), &m(), 50, 49, 1_100), Err(VaultError::InsufficientFunds));
        assert!(check_pay(&state(&a), &m(), 50, 50, 1_100).is_ok());
    }

    #[test]
    fn overflow_is_over_daily_limit() {
        let a = [m()];
        let mut s = state(&a);
        s.max_per_order = u64::MAX;
        s.daily_limit = u64::MAX;
        s.spent_today = u64::MAX;
        assert_eq!(check_pay(&s, &m(), 1, u64::MAX, 1_100), Err(VaultError::OverDailyLimit));
    }

    #[test]
    fn zero_amount_rejected() {
        let a = [m()];
        assert_eq!(check_pay(&state(&a), &m(), 0, 1_000, 1_100), Err(VaultError::ZeroAmount));
    }

    fn k(b: u8) -> Pubkey {
        Pubkey::new_from_array([b; 32])
    }

    #[test]
    fn rules_valid() {
        assert_eq!(check_rules(&k(1), &k(2), 100, 100, &[k(3), k(4)]), Ok(()));
        assert_eq!(check_rules(&k(1), &k(2), 1, 250, &[]), Ok(()));
    }

    #[test]
    fn rules_zero_limits() {
        assert_eq!(check_rules(&k(1), &k(2), 0, 100, &[]), Err(VaultError::ZeroLimit));
        assert_eq!(check_rules(&k(1), &k(2), 0, 0, &[]), Err(VaultError::ZeroLimit));
    }

    #[test]
    fn rules_per_order_over_daily() {
        assert_eq!(check_rules(&k(1), &k(2), 101, 100, &[]), Err(VaultError::PerOrderOverDaily));
    }

    #[test]
    fn rules_agent_is_owner() {
        assert_eq!(check_rules(&k(1), &k(1), 10, 100, &[]), Err(VaultError::AgentIsOwner));
    }

    #[test]
    fn rules_duplicate_merchant() {
        assert_eq!(
            check_rules(&k(1), &k(2), 10, 100, &[k(3), k(4), k(3)]),
            Err(VaultError::DuplicateMerchant)
        );
    }

    #[test]
    fn rules_merchant_count_boundary() {
        let ten: Vec<Pubkey> = (10..10 + MAX_MERCHANTS as u8).map(k).collect();
        assert_eq!(check_rules(&k(1), &k(2), 10, 100, &ten), Ok(()));
        let eleven: Vec<Pubkey> = (10..11 + MAX_MERCHANTS as u8).map(k).collect();
        assert_eq!(check_rules(&k(1), &k(2), 10, 100, &eleven), Err(VaultError::TooManyMerchants));
    }
}
