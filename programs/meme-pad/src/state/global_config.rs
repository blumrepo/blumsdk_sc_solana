use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct GlobalConfig {
    pub authority: Pubkey,
    pub fee_recipient: Pubkey,
    pub migration_account: Pubkey,
    pub fee_basis_points: u8,
    pub token_supply: u64,
    pub token_threshold: u64,
    pub curve_a: u64,
}

impl GlobalConfig {
    pub const SEED_PREFIX: &'static str = "global_config";
}
