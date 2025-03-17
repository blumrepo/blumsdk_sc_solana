use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct BondingCurve {
    pub reserve_sol: u64,
    pub reserve_token: u64,
    pub token_threshold: u64,
    pub curve_a: u64,
}

impl BondingCurve {
    pub const SEED_PREFIX: &'static str = "bonding_curve";
}
