use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct MintAuthorityPda {}

impl MintAuthorityPda {
    pub const SEED_PREFIX: &'static str = "mint_authority";
}
