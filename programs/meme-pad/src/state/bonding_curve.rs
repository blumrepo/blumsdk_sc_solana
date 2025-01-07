use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token::{transfer, Mint, Token, TokenAccount, Transfer};

use crate::state::GlobalConfig;
use crate::tokenomics::{calculate_sol_amount_for_buy, calculate_sol_amount_for_sell};

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
        amount: u64,
        max_sol_cost: u64,
    ) -> Result<()> {
        let circulating_supply = self.token_threshold - self.reserve_token;
        let sol_amount = calculate_sol_amount_for_buy(amount, circulating_supply, self.curve_a);

        require!(sol_amount <= max_sol_cost, ErrorCode::MoreThanMaxSolCost);

        let fee_amount = sol_amount / global_config.fee_basis_points as u64;

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
            amount,
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

        self.reserve_token -= amount;
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
        amount: u64,
        min_sol_cost: u64,
    ) -> Result<()> {
        let circulating_supply = self.token_threshold - self.reserve_token;
        let sol_amount = calculate_sol_amount_for_sell(amount, circulating_supply, self.curve_a);

        require!(sol_amount >= min_sol_cost, ErrorCode::LessThanMinSolCost);

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
            amount,
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

        self.reserve_token += amount;
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

        require!( self.reserve_token == 0, ErrorCode::BondingCurveNotComplete);

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
    #[msg("Calculated sol cost is more than max sol cost")]
    MoreThanMaxSolCost,
    #[msg("Calculated sol cost is less than min sol cost")]
    LessThanMinSolCost,
    #[msg("Withdraw not allowed before threshold reached")]
    BondingCurveNotComplete,
}
