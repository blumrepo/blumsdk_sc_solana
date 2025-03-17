use crate::errors::ErrorCode;
use crate::events::BuyEvent;
use crate::instructions::Trade;
use crate::state::BondingCurve;
use crate::tokenomics::{calculate_sol_amount, calculate_token_amount};
use crate::types::ReferralData;
use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token::{transfer, Transfer};

pub fn buy(
    ctx: Context<Trade>,
    mut sol_amount: u64,
    mut min_token_amount: u64,
    referral_data: ReferralData,
) -> Result<()> {
    let bonding_curve = &mut ctx.accounts.bonding_curve;

    require!(
        bonding_curve.reserve_token != 0,
        ErrorCode::BondingCurveCompleted
    );
    require!(sol_amount != 0, ErrorCode::ZeroAmount);

    let circulating_supply = bonding_curve.token_threshold - bonding_curve.reserve_token;
    let mut token_amount =
        calculate_token_amount(sol_amount, circulating_supply, bonding_curve.curve_a);

    if token_amount > bonding_curve.reserve_token {
        token_amount = bonding_curve.reserve_token;
        let new_sol_amount = calculate_sol_amount(
            token_amount,
            bonding_curve.token_threshold,
            bonding_curve.curve_a,
        ) + 1;
        min_token_amount =
            (((new_sol_amount as u128) * (min_token_amount as u128)) / (sol_amount as u128)) as u64;
        sol_amount = new_sol_amount;
    }

    require!(
        token_amount >= min_token_amount,
        ErrorCode::LessThanMinTokenAmount
    );

    let fee_amount = sol_amount * ctx.accounts.global_config.buy_fee_bps as u64 / 10_000u64;

    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.user.to_account_info(),
                to: bonding_curve.to_account_info(),
            },
        ),
        sol_amount,
    )?;

    transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.user_token_account.to_account_info(),
                authority: bonding_curve.to_account_info(),
            },
            &[&[
                BondingCurve::SEED_PREFIX.as_bytes(),
                ctx.accounts.mint_account.key().as_ref(),
                &[ctx.bumps.bonding_curve],
            ]],
        ),
        token_amount,
    )?;

    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.user.to_account_info(),
                to: ctx.accounts.fee_recipient.to_account_info(),
            },
        ),
        fee_amount,
    )?;

    bonding_curve.reserve_token -= token_amount;
    bonding_curve.reserve_sol += sol_amount;

    emit_cpi!(BuyEvent {
        buyer: ctx.accounts.user.key(),
        sol_amount,
        token_amount,
        reserve_sol: bonding_curve.reserve_sol,
        reserve_token: bonding_curve.reserve_sol,
        referral_data
    });

    Ok(())
}
