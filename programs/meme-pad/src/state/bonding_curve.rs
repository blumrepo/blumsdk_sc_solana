use crate::state::GlobalConfig;
use crate::tokenomics::{calculate_sol_amount, calculate_token_amount};
use anchor_lang::prelude::*;
use anchor_lang::solana_program::log::sol_log_64;
use anchor_lang::system_program;
use anchor_spl::token::{transfer, Mint, Token, TokenAccount, Transfer};
use num_bigint::BigInt;
use num_traits::ToPrimitive;

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
        amount: u64,
        max_sol_cost: u64,
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
        amount: u64,
        min_sol_cost: u64,
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
        sol_amount: u64,
        min_token_receive: u64,
    ) -> Result<()> {
        require!(self.reserve_token > 0, ErrorCode::BondingCurveIsComplete);
        require!(sol_amount > 0, ErrorCode::ZeroSolAmount);

        let circulating_supply = self.token_threshold - self.reserve_token;

        let mut token_amount = calculate_token_amount(circulating_supply, self.curve_a, sol_amount);
        let mut correct_sol_amount = sol_amount;
        let mut correct_min_token_receive = min_token_receive;

        msg!("Calculated token amount: {}", token_amount);

        if token_amount > self.reserve_token {
            token_amount = self.reserve_token;
            correct_sol_amount =
                calculate_sol_amount(self.token_threshold, self.curve_a, token_amount);
            correct_min_token_receive = (BigInt::from(correct_sol_amount)
                * BigInt::from(min_token_receive)
                / BigInt::from(sol_amount))
            .to_u64()
            .unwrap();
        }

        require!(
            token_amount >= correct_min_token_receive,
            ErrorCode::LessThanMinTokenReceive
        );

        let fee_amount = correct_sol_amount / global_config.fee_basis_points as u64;

        system_program::transfer(
            CpiContext::new(
                system_program.to_account_info(),
                system_program::Transfer {
                    from: user.to_account_info(),
                    to: self.to_account_info(),
                },
            ),
            correct_sol_amount,
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
        self.reserve_sol += correct_sol_amount;

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
        min_sol_receive: u64,
    ) -> Result<()> {
        require!(self.reserve_token > 0, ErrorCode::BondingCurveIsComplete);

        let circulating_supply = self.token_threshold - self.reserve_token;
        let sol_amount = calculate_sol_amount(circulating_supply, self.curve_a, token_amount);

        require!(
            sol_amount >= min_sol_receive,
            ErrorCode::LessThanMinSolReceive
        );

        let fee_amount = sol_amount / global_config.fee_basis_points as u64;

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

        **self.to_account_info().try_borrow_mut_lamports()? -= sol_amount;
        **user.try_borrow_mut_lamports()? += sol_amount;

        self.reserve_token += token_amount;
        self.reserve_sol -= sol_amount;

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
        require!(self.reserve_token == 0, ErrorCode::BondingCurveNotComplete);

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
    #[msg("Zero sol amount is not allowed for trade")]
    ZeroSolAmount,
    #[msg("Calculated token amount is less than min token receive")]
    LessThanMinTokenReceive,
    #[msg("Calculated sol amount is less than min sol receive")]
    LessThanMinSolReceive,
    #[msg("Trade is not allowed after bonding curve is complete")]
    BondingCurveIsComplete,
    #[msg("Withdraw not allowed before bonding curve is complete")]
    BondingCurveNotComplete,
}
