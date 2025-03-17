use crate::errors::ErrorCode;
use crate::state::{BondingCurve, GlobalConfig};
use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{transfer, Transfer};
use anchor_spl::token::{Mint, Token, TokenAccount};

pub fn withdraw(ctx: Context<Withdraw>) -> Result<()> {
    let bonding_curve = &mut ctx.accounts.bonding_curve;

    require!(
        bonding_curve.reserve_token == 0,
        ErrorCode::BondingCurveNotCompleted
    );
    require!(
        bonding_curve.reserve_sol != 0 || ctx.accounts.vault.amount != 0,
        ErrorCode::AlreadyWithdrawn
    );

    transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.migration_token_account.to_account_info(),
                authority: bonding_curve.to_account_info(),
            },
            &[&[
                BondingCurve::SEED_PREFIX.as_bytes(),
                ctx.accounts.mint_account.key().as_ref(),
                &[ctx.bumps.bonding_curve],
            ]],
        ),
        ctx.accounts.vault.amount,
    )?;

    **bonding_curve.to_account_info().try_borrow_mut_lamports()? -= bonding_curve.reserve_sol;
    **ctx.accounts.migration_account.try_borrow_mut_lamports()? += bonding_curve.reserve_sol;

    bonding_curve.reserve_token = 0;
    bonding_curve.reserve_sol = 0;

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
