use crate::errors::ErrorCode;
use crate::events::SellEvent;
use crate::instructions::Trade;
use crate::tokenomics::calculate_sol_amount;
use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token::{transfer, Transfer};

pub fn sell(ctx: Context<Trade>, token_amount: u64, min_sol_amount: u64) -> Result<()> {
    let bonding_curve = &mut ctx.accounts.bonding_curve;

    require!(
        bonding_curve.reserve_token != 0,
        ErrorCode::BondingCurveCompleted
    );
    require!(token_amount != 0, ErrorCode::ZeroAmount);

    let circulating_supply = bonding_curve.token_threshold - bonding_curve.reserve_token;
    let mut sol_amount =
        calculate_sol_amount(token_amount, circulating_supply, bonding_curve.curve_a);

    if sol_amount > 0 {
        sol_amount -= 1;
    }

    require!(
        sol_amount >= min_sol_amount,
        ErrorCode::LessThanMinSolAmount
    );

    let fee_amount = sol_amount * ctx.accounts.global_config.sell_fee_bps as u64 / 10_000u64;

    transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.user_token_account.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        token_amount,
    )?;

    if fee_amount > 0 {
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
    }

    if sol_amount > 0 {
        **bonding_curve.to_account_info().try_borrow_mut_lamports()? -= sol_amount;
        **ctx.accounts.user.try_borrow_mut_lamports()? += sol_amount;

        bonding_curve.reserve_sol -= sol_amount;
    }

    bonding_curve.reserve_token += token_amount;

    emit_cpi!(SellEvent {
        seller: ctx.accounts.user.key(),
        sol_amount,
        token_amount,
        reserve_sol: bonding_curve.reserve_sol,
        reserve_token: bonding_curve.reserve_sol,
    });

    Ok(())
}
