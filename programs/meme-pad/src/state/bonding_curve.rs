use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token::{transfer, Mint, Token, TokenAccount, Transfer};
use std::cmp::min;

use crate::state::GlobalConfig;
use crate::tokenomics::{calculate_sol_amount, calculate_token_amount};

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

pub trait BondingCurveAccount<'info> {
    fn buy(
        &mut self,
        global_config: &Account<'info, GlobalConfig>,
        fee_recipient: &AccountInfo<'info>,
        mint_account: &Account<'info, Mint>,
        user: &Signer<'info>,
        user_token_account: &mut Account<'info, TokenAccount>,
        vault: &mut Account<'info, TokenAccount>,
        bonding_curve_bump: u8,
        token_program: &Program<'info, Token>,
        system_program: &Program<'info, System>,
        sol_amount: u64,
        min_token_amount: u64,
    ) -> Result<()>;

    fn sell(
        &mut self,
        global_config: &Account<'info, GlobalConfig>,
        fee_recipient: &AccountInfo<'info>,
        user: &Signer<'info>,
        user_token_account: &mut Account<'info, TokenAccount>,
        vault: &mut Account<'info, TokenAccount>,
        token_program: &Program<'info, Token>,
        system_program: &Program<'info, System>,
        token_amount: u64,
        min_sol_amount: u64,
    ) -> Result<()>;

    fn withdraw(
        &mut self,
        mint_account: &Account<'info, Mint>,
        migration_account: &Signer<'info>,
        migration_token_account: &mut Account<'info, TokenAccount>,
        vault: &mut Account<'info, TokenAccount>,
        bonding_curve_bump: u8,
        token_program: &Program<'info, Token>,
    ) -> Result<()>;
}

impl<'info> BondingCurveAccount<'info> for Account<'info, BondingCurve> {
    fn buy(
        &mut self,
        global_config: &Account<'info, GlobalConfig>,
        fee_recipient: &AccountInfo<'info>,
        mint_account: &Account<'info, Mint>,
        user: &Signer<'info>,
        user_token_account: &mut Account<'info, TokenAccount>,
        vault: &mut Account<'info, TokenAccount>,
        bonding_curve_bump: u8,
        token_program: &Program<'info, Token>,
        system_program: &Program<'info, System>,
        mut sol_amount: u64,
        mut min_token_amount: u64,
    ) -> Result<()> {
        require!(self.reserve_token != 0, ErrorCode::BondingCurveCompleted);
        require!(sol_amount != 0, ErrorCode::ZeroAmount);

        let circulating_supply = self.token_threshold - self.reserve_token;
        let mut token_amount = calculate_token_amount(sol_amount, circulating_supply, self.curve_a);

        if token_amount > self.reserve_token {
            token_amount = self.reserve_token;
            let new_sol_amount =
                calculate_sol_amount(token_amount, self.token_threshold, self.curve_a) + 1;
            min_token_amount = (((new_sol_amount as u128) * (min_token_amount as u128))
                / (sol_amount as u128)) as u64;
            sol_amount = new_sol_amount;
        }

        require!(
            token_amount >= min_token_amount,
            ErrorCode::LessThanMinTokenAmount
        );

        let fee_amount = sol_amount * global_config.fee_basis_points as u64 / 10_000u64;

        system_program::transfer(
            CpiContext::new(
                system_program.to_account_info(),
                system_program::Transfer {
                    from: user.to_account_info(),
                    to: self.to_account_info(),
                },
            ),
            sol_amount,
        )?;

        transfer(
            CpiContext::new_with_signer(
                token_program.to_account_info(),
                Transfer {
                    from: vault.to_account_info(),
                    to: user_token_account.to_account_info(),
                    authority: self.to_account_info(),
                },
                &[&[
                    BondingCurve::SEED_PREFIX.as_bytes(),
                    mint_account.key().as_ref(),
                    &[bonding_curve_bump],
                ]],
            ),
            token_amount,
        )?;

        system_program::transfer(
            CpiContext::new(
                system_program.to_account_info(),
                system_program::Transfer {
                    from: user.to_account_info(),
                    to: fee_recipient.to_account_info(),
                },
            ),
            fee_amount,
        )?;

        self.reserve_token -= token_amount;
        self.reserve_sol += sol_amount;

        Ok(())
    }

    fn sell(
        &mut self,
        global_config: &Account<'info, GlobalConfig>,
        fee_recipient: &AccountInfo<'info>,
        user: &Signer<'info>,
        user_token_account: &mut Account<'info, TokenAccount>,
        vault: &mut Account<'info, TokenAccount>,
        token_program: &Program<'info, Token>,
        system_program: &Program<'info, System>,
        token_amount: u64,
        min_sol_amount: u64,
    ) -> Result<()> {
        require!(self.reserve_token != 0, ErrorCode::BondingCurveCompleted);
        require!(token_amount != 0, ErrorCode::ZeroAmount);

        let circulating_supply = self.token_threshold - self.reserve_token;
        let mut sol_amount = calculate_sol_amount(token_amount, circulating_supply, self.curve_a);

        if sol_amount > 0 {
            sol_amount -= 1;
        }

        require!(
            sol_amount >= min_sol_amount,
            ErrorCode::LessThanMinSolAmount
        );

        let fee_amount = sol_amount * global_config.fee_basis_points as u64 / 10_000u64;

        transfer(
            CpiContext::new(
                token_program.to_account_info(),
                Transfer {
                    from: user_token_account.to_account_info(),
                    to: vault.to_account_info(),
                    authority: user.to_account_info(),
                },
            ),
            token_amount,
        )?;

        if fee_amount > 0 {
            system_program::transfer(
                CpiContext::new(
                    system_program.to_account_info(),
                    system_program::Transfer {
                        from: user.to_account_info(),
                        to: fee_recipient.to_account_info(),
                    },
                ),
                fee_amount,
            )?;
        }

        if sol_amount > 0 {
            **self.to_account_info().try_borrow_mut_lamports()? -= sol_amount;
            **user.try_borrow_mut_lamports()? += sol_amount;

            self.reserve_sol -= sol_amount;
        }

        self.reserve_token += token_amount;

        Ok(())
    }

    fn withdraw(
        &mut self,
        mint_account: &Account<'info, Mint>,
        migration_account: &Signer<'info>,
        migration_account_token_account: &mut Account<'info, TokenAccount>,
        vault: &mut Account<'info, TokenAccount>,
        bonding_curve_bump: u8,
        token_program: &Program<'info, Token>,
    ) -> Result<()> {
        require!(self.reserve_token == 0, ErrorCode::BondingCurveNotCompleted);
        require!(
            self.reserve_sol != 0 || vault.amount != 0,
            ErrorCode::AlreadyWithdrawn
        );

        transfer(
            CpiContext::new_with_signer(
                token_program.to_account_info(),
                Transfer {
                    from: vault.to_account_info(),
                    to: migration_account_token_account.to_account_info(),
                    authority: self.to_account_info(),
                },
                &[&[
                    BondingCurve::SEED_PREFIX.as_bytes(),
                    mint_account.key().as_ref(),
                    &[bonding_curve_bump],
                ]],
            ),
            vault.amount,
        )?;

        **self.to_account_info().try_borrow_mut_lamports()? -= self.reserve_sol;
        **migration_account.try_borrow_mut_lamports()? += self.reserve_sol;

        self.reserve_token = 0;
        self.reserve_sol = 0;

        Ok(())
    }
}

#[error_code]
enum ErrorCode {
    #[msg("Calculated token amount is less than min token amount")]
    LessThanMinTokenAmount,
    #[msg("Calculated sol amount is less than min sol amount")]
    LessThanMinSolAmount,
    #[msg("Trade not allowed after threshold reached")]
    BondingCurveCompleted,
    #[msg("Withdraw not allowed before threshold reached")]
    BondingCurveNotCompleted,
    #[msg("Trade not allow for zero amount")]
    ZeroAmount,
    #[msg("Already withdrawn")]
    AlreadyWithdrawn,
}
