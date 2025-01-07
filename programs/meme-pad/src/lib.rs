use anchor_lang::prelude::*;
use instructions::*;

pub mod consts;
pub mod instructions;
pub mod state;
mod tokenomics;

declare_id!("3ZEqFj8xa6ZG67et6ve5prKDymp2Po6im6B2HeRv5Zee");

#[program]
pub mod meme_pad {
    use super::*;

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
        instructions::initialize(
            ctx,
            authority,
            fee_recipient,
            migration_account,
            fee_basis_points,
            token_supply,
            token_threshold,
            curve_a,
        )
    }

    pub fn create(ctx: Context<Create>, name: String, symbol: String, uri: String) -> Result<()> {
        instructions::create(ctx, name, symbol, uri)
    }

    pub fn buy(ctx: Context<Trade>, amount: u64, max_sol_cost: u64) -> Result<()> {
        instructions::buy(ctx, amount, max_sol_cost)
    }

    pub fn sell(ctx: Context<Trade>, amount: u64, min_sol_cost: u64) -> Result<()> {
        instructions::sell(ctx, amount, min_sol_cost)
    }

    pub fn withdraw(ctx: Context<Withdraw>) -> Result<()> {
        instructions::withdraw(ctx)
    }
}
