use {
    anchor_lang::prelude::*,
    anchor_spl::{
        associated_token::AssociatedToken,
        token::{Mint, Token, TokenAccount},
    },
};

use crate::state::{BondingCurve, BondingCurveAccount, GlobalConfig};

pub fn buy(ctx: Context<Trade>, amount: u64, max_sol_cost: u64) -> Result<()> {
    let bonding_curve = &mut ctx.accounts.bonding_curve;

    bonding_curve.buy(
        &ctx.accounts.global_config,
        &ctx.accounts.fee_recipient,
        &ctx.accounts.mint_account,
        &ctx.accounts.user,
        &mut ctx.accounts.user_token_account,
        &mut ctx.accounts.vault,
        ctx.bumps.bonding_curve,
        &ctx.accounts.token_program,
        &ctx.accounts.system_program,
        amount,
        max_sol_cost,
    )?;

    Ok(())
}

pub fn sell(ctx: Context<Trade>, amount: u64, min_sol_cost: u64) -> Result<()> {
    let bonding_curve = &mut ctx.accounts.bonding_curve;

    bonding_curve.sell(
        &ctx.accounts.global_config,
        &ctx.accounts.fee_recipient,
        &ctx.accounts.user,
        &mut ctx.accounts.user_token_account,
        &mut ctx.accounts.vault,
        &ctx.accounts.token_program,
        &ctx.accounts.system_program,
        amount,
        min_sol_cost,
    )?;

    Ok(())
}

#[derive(Accounts)]
pub struct Trade<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        has_one = fee_recipient,
        seeds = [GlobalConfig::SEED_PREFIX.as_bytes()],
        bump,
    )]
    pub global_config: Box<Account<'info, GlobalConfig>>,

    /// CHECK: checked in global config
    #[account(mut)]
    pub fee_recipient: AccountInfo<'info>,

    #[account(mut)]
    pub mint_account: Box<Account<'info, Mint>>,

    #[account(
        mut,
        associated_token::mint = mint_account,
        associated_token::authority = user,
    )]
    pub user_token_account: Box<Account<'info, TokenAccount>>,

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

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}
