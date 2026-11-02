//! Pure fee-flywheel rules: DexScreener escrow top-up and release, and
//! sweeping buyback / holder / treasury buckets out of a curve.
//!
//! Escrow policy (locked decision): the escrow stays open after graduation.
//! Post-graduation protocol fees (e.g. collected Raydium LP fees) can top it
//! up until `dex_target_lamports`; once funded it is released to the treasury
//! to place the DexScreener order.

use anchor_lang::prelude::*;

use crate::error::ParabullError;
use crate::state::BondingCurve;

/// Lamports a top-up will actually accept: capped at the remaining room.
pub fn escrow_top_up_amount(curve: &BondingCurve, target: u64, amount: u64) -> Result<u64> {
    require!(!curve.escrow_released, ParabullError::EscrowAlreadyReleased);
    require!(amount > 0, ParabullError::ZeroAmount);
    let room = target.saturating_sub(curve.escrow_accrued);
    require!(room > 0, ParabullError::EscrowAlreadyFunded);
    Ok(amount.min(room))
}

pub fn apply_escrow_top_up(curve: &mut BondingCurve, accepted: u64) -> Result<()> {
    curve.escrow_accrued = curve.escrow_accrued.checked_add(accepted).ok_or(ParabullError::Overflow)?;
    Ok(())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EscrowRelease {
    /// Exactly `dex_target_lamports`, paid to the treasury for the DexScreener order.
    pub to_treasury: u64,
    /// Any escrow above the target (only possible if the admin lowered the
    /// target after fees accrued) moves to the buyback bucket.
    pub excess_to_buyback: u64,
}

/// Release a funded escrow. Mutates the curve; the caller moves the lamports.
pub fn release_escrow(curve: &mut BondingCurve, target: u64) -> Result<EscrowRelease> {
    require!(!curve.escrow_released, ParabullError::EscrowAlreadyReleased);
    require!(target > 0, ParabullError::EscrowNotFunded);
    require!(curve.escrow_accrued >= target, ParabullError::EscrowNotFunded);
    let excess = curve.escrow_accrued - target;
    curve.buyback_accrued = curve.buyback_accrued.checked_add(excess).ok_or(ParabullError::Overflow)?;
    curve.escrow_accrued = 0;
    curve.escrow_released = true;
    Ok(EscrowRelease { to_treasury: target, excess_to_buyback: excess })
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct FeeSweep {
    pub to_buyback_vault: u64,
    pub to_holder_vault: u64,
    pub to_treasury: u64,
}

impl FeeSweep {
    pub fn total(&self) -> Result<u64> {
        self.to_buyback_vault
            .checked_add(self.to_holder_vault)
            .and_then(|v| v.checked_add(self.to_treasury))
            .ok_or_else(|| error!(ParabullError::Overflow))
    }
}

/// Empty the buyback / holder / treasury buckets. The escrow bucket is never
/// swept: it stays on the curve until released.
pub fn take_sweepable_fees(curve: &mut BondingCurve) -> FeeSweep {
    let sweep = FeeSweep {
        to_buyback_vault: curve.buyback_accrued,
        to_holder_vault: curve.holder_accrued,
        to_treasury: curve.treasury_accrued,
    };
    curve.buyback_accrued = 0;
    curve.holder_accrued = 0;
    curve.treasury_accrued = 0;
    sweep
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::*;
    use crate::state::fixtures::{curve, global};
    use crate::trade::{apply_buy, apply_sell};

    const OPEN: u64 = 1_000 + DEFAULT_TRADING_OPEN_DELAY_SLOTS;
    const TARGET: u64 = 2_000_000_000; // fixtures' dex_target_lamports

    fn code(e: anchor_lang::error::Error) -> u32 {
        match e {
            anchor_lang::error::Error::AnchorError(a) => a.error_code_number,
            other => panic!("unexpected error {other:?}"),
        }
    }

    fn err(e: ParabullError) -> u32 {
        e.into()
    }

    #[test]
    fn top_up_is_capped_at_remaining_room() {
        let g = global();
        let mut c = curve(&g);
        c.escrow_accrued = TARGET - 300;
        assert_eq!(escrow_top_up_amount(&c, TARGET, 100).unwrap(), 100);
        assert_eq!(escrow_top_up_amount(&c, TARGET, 1_000).unwrap(), 300, "only the room is accepted");
        apply_escrow_top_up(&mut c, 300).unwrap();
        assert_eq!(c.escrow_accrued, TARGET);
        assert_eq!(code(escrow_top_up_amount(&c, TARGET, 1).unwrap_err()), err(ParabullError::EscrowAlreadyFunded));
        assert_eq!(code(escrow_top_up_amount(&c, TARGET, 0).unwrap_err()), err(ParabullError::ZeroAmount));
    }

    #[test]
    fn release_requires_funded_and_happens_once() {
        let g = global();
        let mut c = curve(&g);
        c.escrow_accrued = TARGET - 1;
        assert_eq!(code(release_escrow(&mut c, TARGET).unwrap_err()), err(ParabullError::EscrowNotFunded));
        c.escrow_accrued = TARGET;
        let r = release_escrow(&mut c, TARGET).unwrap();
        assert_eq!(r, EscrowRelease { to_treasury: TARGET, excess_to_buyback: 0 });
        assert!(c.escrow_released);
        assert_eq!(c.escrow_accrued, 0);
        assert_eq!(code(release_escrow(&mut c, TARGET).unwrap_err()), err(ParabullError::EscrowAlreadyReleased));
        assert_eq!(code(escrow_top_up_amount(&c, TARGET, 1).unwrap_err()), err(ParabullError::EscrowAlreadyReleased));
    }

    #[test]
    fn lowered_target_sends_excess_to_buyback() {
        let g = global();
        let mut c = curve(&g);
        c.escrow_accrued = TARGET;
        c.buyback_accrued = 5;
        let r = release_escrow(&mut c, TARGET - 400).unwrap();
        assert_eq!(r, EscrowRelease { to_treasury: TARGET - 400, excess_to_buyback: 400 });
        assert_eq!(c.buyback_accrued, 405);
    }

    #[test]
    fn zero_target_never_releases() {
        let g = global();
        let mut c = curve(&g);
        assert_eq!(code(release_escrow(&mut c, 0).unwrap_err()), err(ParabullError::EscrowNotFunded));
    }

    #[test]
    fn sweep_takes_flywheel_buckets_but_never_escrow() {
        let g = global();
        let mut c = curve(&g);
        c.escrow_accrued = 11;
        c.buyback_accrued = 22;
        c.holder_accrued = 33;
        c.treasury_accrued = 44;
        let s = take_sweepable_fees(&mut c);
        assert_eq!(s, FeeSweep { to_buyback_vault: 22, to_holder_vault: 33, to_treasury: 44 });
        assert_eq!(s.total().unwrap(), 99);
        assert_eq!((c.escrow_accrued, c.buyback_accrued, c.holder_accrued, c.treasury_accrued), (11, 0, 0, 0));
        assert_eq!(take_sweepable_fees(&mut c), FeeSweep::default(), "second sweep is a no-op");
    }

    /// Option 1 end to end: a token graduates with an under-funded escrow, the
    /// escrow stays open, post-graduation top-ups fund it, then it is released.
    #[test]
    fn graduated_curve_escrow_stays_open_until_topped_up() {
        let g = global();
        let mut c = curve(&g);
        apply_buy(&mut c, &g, OPEN, 300_000_000_000_000, u64::MAX).unwrap();
        apply_sell(&mut c, &g, OPEN, 100_000_000_000_000, 0).unwrap();
        let out = apply_buy(&mut c, &g, OPEN, u64::MAX, u64::MAX).unwrap();
        assert!(out.graduated && c.complete);

        let at_graduation = c.escrow_accrued;
        assert!(at_graduation > 0 && at_graduation < TARGET, "under-funded at graduation: {at_graduation}");
        assert!(!c.escrow_released);
        assert_eq!(code(release_escrow(&mut c, TARGET).unwrap_err()), err(ParabullError::EscrowNotFunded));

        // Post-graduation LP-fee top-ups; the last one over-pays and is capped.
        let room = TARGET - at_graduation;
        let first = escrow_top_up_amount(&c, TARGET, room / 2).unwrap();
        apply_escrow_top_up(&mut c, first).unwrap();
        let second = escrow_top_up_amount(&c, TARGET, room).unwrap();
        assert_eq!(first + second, room);
        apply_escrow_top_up(&mut c, second).unwrap();

        let r = release_escrow(&mut c, TARGET).unwrap();
        assert_eq!(r.to_treasury, TARGET);
        assert!(c.escrow_released);
    }
}
