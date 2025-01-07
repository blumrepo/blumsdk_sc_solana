use anchor_lang::prelude::*;

use crate::consts::DISCRIMINATOR;
use crate::state::{GlobalConfig, MintAuthorityPda};

pub fn initialize(
    ctx: Context<Initialize>,
    authority: Pubkey,
    fee_recipient: Pubkey,
    migration_account: Pubkey,
    fee_basis_points: u8,
    token_supply: u64,
    token_threshold: u64,
    curve_a: u64,
) -> Result<()> {
    **ctx.accounts.global_config = GlobalConfig {
        authority,
        fee_recipient,
        migration_account,
        fee_basis_points,
        token_supply,
        token_threshold,
        curve_a,
    };

    Ok(())
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        init,
        payer = user,
        space = DISCRIMINATOR + GlobalConfig::INIT_SPACE,
        seeds = [GlobalConfig::SEED_PREFIX.as_bytes()],
        bump,
    )]
    pub global_config: Box<Account<'info, GlobalConfig>>,

    #[account(
        init,
        payer = user,
        space = DISCRIMINATOR + MintAuthorityPda::INIT_SPACE,
        seeds = [MintAuthorityPda::SEED_PREFIX.as_bytes()],
        bump,
    )]
    pub mint_authority: Box<Account<'info, MintAuthorityPda>>,

    pub system_program: Program<'info, System>,
}
