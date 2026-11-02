//! Differential tests: Parabull curve/fee math must match the reconstructed
//! pump.fun program in `reference/programs/pump` exactly, across random curve
//! states and trade sizes.

use anchor_lang::prelude::Pubkey;
use parabull::constants::*;
use parabull::math::{self, Reserves};
use pump_recovered::trade_types::BondingCurve as RefCurve;

fn ref_curve(r: &Reserves) -> RefCurve {
    RefCurve {
        virtual_token_reserves: r.virtual_token,
        virtual_quote_reserves: r.virtual_sol,
        real_token_reserves: r.real_token,
        real_quote_reserves: r.real_sol,
        token_total_supply: DEFAULT_TOKEN_TOTAL_SUPPLY,
        complete: false,
        creator: Pubkey::new_unique(),
        is_mayhem_mode: false,
        is_cashback_coin: false,
        quote_mint: Pubkey::default(),
        creator_fee_bps: 0,
        can_edit_creator_fee: false,
        is_holder_reward: false,
        creator_fee: 0,
        protocol_fees: 0,
        depth: 0,
        initial_virtual_quote_reserves: r.virtual_sol,
        post_complete_base_out: 0,
        post_complete_quote_in: 0,
    }
}

fn fresh() -> Reserves {
    Reserves {
        virtual_token: DEFAULT_INITIAL_VIRTUAL_TOKEN_RESERVES,
        virtual_sol: DEFAULT_INITIAL_VIRTUAL_SOL_RESERVES,
        real_token: DEFAULT_INITIAL_REAL_TOKEN_RESERVES,
        real_sol: 0,
    }
}

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n.max(1)
    }
}

/// A random point along the default curve (0..=100% of real tokens sold).
fn random_state(rng: &mut Rng) -> Reserves {
    let mut r = fresh();
    let sold = rng.below(r.real_token);
    if sold > 0 {
        let cost = math::buy_cost(&r, sold).unwrap();
        r.apply_buy(sold, cost).unwrap();
    }
    r
}

const ITERS: usize = 50_000;

#[test]
fn buy_cost_matches_reference_buy_quote() {
    let mut rng = Rng(0x1234_5678_9ABC_DEF1);
    for _ in 0..ITERS {
        let r = random_state(&mut rng);
        let amount = rng.below(r.virtual_token + 1);
        let ours = math::buy_cost(&r, amount);
        let theirs = pump_recovered::buy_quote(&ref_curve(&r), amount);
        match (ours, theirs) {
            (Ok(a), Ok(b)) => assert_eq!(u128::from(a), b, "amount={amount} r={r:?}"),
            (Err(_), Err(_)) => {}
            (a, b) => panic!("divergence amount={amount} r={r:?}: ours={a:?} ref={b:?}"),
        }
    }
}

#[test]
fn sell_proceeds_matches_reference_sell_quote() {
    let mut rng = Rng(0x0FED_CBA9_8765_4321);
    for _ in 0..ITERS {
        let r = random_state(&mut rng);
        let amount = rng.below(DEFAULT_TOKEN_TOTAL_SUPPLY);
        let ours = math::sell_proceeds(&r, amount).unwrap();
        let theirs = ref_curve(&r).sell_quote(amount).unwrap();
        assert_eq!(u128::from(ours), theirs, "amount={amount} r={r:?}");
    }
}

#[test]
fn tokens_for_sol_matches_reference_tokens_for_quote() {
    let mut rng = Rng(0xDEAD_BEEF_CAFE_F00D);
    for _ in 0..ITERS {
        let r = random_state(&mut rng);
        let sol = rng.below(200_000_000_000);
        let ours = math::tokens_for_sol(&r, sol);
        let theirs = pump_recovered::tokens_for_quote(&ref_curve(&r), sol);
        match (ours, theirs) {
            (Ok(a), Ok(b)) => assert_eq!(u128::from(a), b, "sol={sol} r={r:?}"),
            (Err(_), Err(_)) => {}
            (a, b) => panic!("divergence sol={sol} r={r:?}: ours={a:?} ref={b:?}"),
        }
    }
}

#[test]
fn fee_matches_reference_ceil_fee() {
    let mut rng = Rng(0xA5A5_5A5A_1357_9BDF);
    let edge = [0u64, 1, 99, 100, 101, 9_999, 10_000, 10_001, u64::MAX / 10_000, u64::MAX];
    for &amount in &edge {
        for bps in [0u16, 1, 50, 99, 100] {
            let ours = math::fee(amount, bps);
            let theirs = pump_recovered::fee_math::fee(amount, u64::from(bps));
            match (ours, theirs) {
                (Ok(a), Ok(b)) => assert_eq!(a, b, "amount={amount} bps={bps}"),
                (Err(_), Err(_)) => {}
                (a, b) => panic!("divergence amount={amount} bps={bps}: ours={a:?} ref={b:?}"),
            }
        }
    }
    for _ in 0..ITERS {
        let amount = rng.next() >> rng.below(64);
        let bps = rng.below(u64::from(MAX_PLATFORM_FEE_BPS) + 1) as u16;
        assert_eq!(
            math::fee(amount, bps).unwrap(),
            pump_recovered::fee_math::fee(amount, u64::from(bps)).unwrap(),
            "amount={amount} bps={bps}"
        );
    }
}

/// The reference computes this inline (`reference/programs/pump/src/buy_v2.rs`,
/// exact-quote-in branch): `(available as u128*10000/(10000+total_bps as u128)) as u64`.
#[test]
fn budget_net_of_fee_matches_reference_inline_formula() {
    let reference = |available: u64, total_bps: u64| -> u64 {
        if total_bps == 0 { available } else { (available as u128 * 10000 / (10000 + total_bps as u128)) as u64 }
    };
    let mut rng = Rng(0x2468_ACE0_1357_9BDF);
    for _ in 0..ITERS {
        let budget = rng.next() >> rng.below(64);
        let bps = rng.below(u64::from(MAX_PLATFORM_FEE_BPS) + 1) as u16;
        assert_eq!(math::sol_budget_net_of_fee(budget, bps).unwrap(), reference(budget, u64::from(bps)));
    }
}

#[test]
fn reserve_updates_match_reference_apply_buy_and_sell() {
    let mut rng = Rng(0x0BAD_C0DE_0BAD_C0DE);
    for _ in 0..ITERS / 5 {
        let mut ours = random_state(&mut rng);
        let mut theirs = ref_curve(&ours);
        if ours.real_token > 0 {
            let tokens = 1 + rng.below(ours.real_token);
            let cost = math::buy_cost(&ours, tokens).unwrap();
            ours.apply_buy(tokens, cost).unwrap();
            theirs.apply_buy(tokens, cost).unwrap();
        }
        let tokens = rng.below(ours.virtual_token);
        let proceeds = math::sell_proceeds(&ours, tokens).unwrap();
        if proceeds <= ours.real_sol {
            ours.apply_sell(tokens, proceeds).unwrap();
            theirs.apply_sell(tokens, proceeds).unwrap();
        }
        assert_eq!(
            (ours.virtual_token, ours.virtual_sol, ours.real_token, ours.real_sol),
            (
                theirs.virtual_token_reserves,
                theirs.virtual_quote_reserves,
                theirs.real_token_reserves,
                theirs.real_quote_reserves
            )
        );
    }
}
