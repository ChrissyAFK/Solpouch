use crate::errors::VaultError;
use anchor_lang::prelude::Pubkey;

pub const DAY_SECONDS: i64 = 86_400;

pub struct PayState<'a> {
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
    if s.frozen {
        return Err(VaultError::PouchFrozen);
    }
    if amount == 0 {
        return Err(VaultError::ZeroAmount);
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

/// The agent must not be an allowed merchant and the list must have no duplicates.
pub fn check_merchants(agent: &Pubkey, merchants: &[Pubkey]) -> Result<(), VaultError> {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zero_amount_rejected() {
        let a = [m()];
        assert_eq!(check_pay(&state(&a), &m(), 0, 1_000, 1_100), Err(VaultError::ZeroAmount));
    }

    #[test]
    fn merchants_validation() {
        let agent = Pubkey::new_from_array([1; 32]);
        let x = Pubkey::new_from_array([2; 32]);
        let y = Pubkey::new_from_array([3; 32]);
        assert_eq!(check_merchants(&agent, &[]), Ok(()));
        assert_eq!(check_merchants(&agent, &[x, y]), Ok(()));
        assert_eq!(check_merchants(&agent, &[x, agent]), Err(VaultError::AgentIsMerchant));
        assert_eq!(check_merchants(&agent, &[x, y, x]), Err(VaultError::DuplicateMerchant));
    }

    fn m() -> Pubkey {
        Pubkey::new_from_array([7; 32])
    }

    fn state(allowed: &[Pubkey]) -> PayState<'_> {
        PayState {
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
}
