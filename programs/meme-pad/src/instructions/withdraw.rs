use crate::state::{BondingCurve, BondingCurveAccount, GlobalConfig};
use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{Mint, Token, TokenAccount};

pub fn withdraw(ctx: Context<Withdraw>) -> Result<()> {
    let bonding_curve = &mut ctx.accounts.bonding_curve;

    bonding_curve.withdraw(
        &ctx.accounts.mint_account,
        &ctx.accounts.migration_account,
        &mut ctx.accounts.migration_token_account,
        &mut ctx.accounts.vault,
        ctx.bumps.bonding_curve,
        &ctx.accounts.token_program,
    )?;

    Ok(())
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut)]
    pub migration_account: Signer<'info>,

    #[account(
        has_one = migration_account,
        seeds = [GlobalConfig::SEED_PREFIX.as_bytes()],
        bump,
    )]
    pub global_config: Box<Account<'info, GlobalConfig>>,

    #[account(mut)]
    pub mint_account: Box<Account<'info, Mint>>,

    #[account(
        mut,
        seeds = [BondingCurve::SEED_PREFIX.as_bytes(), mint_account.key().as_ref()],
        bump,
    )]
    pub bonding_curve: Box<Account<'info, BondingCurve>>,

    #[account(
        mut,
        associated_token::mint = mint_account,
        associated_token::authority = bonding_curve,
    )]
    pub vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        associated_token::mint = mint_account,
        associated_token::authority = migration_account,
    )]
    pub migration_token_account: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}
