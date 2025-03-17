use anchor_lang::prelude::*;
use instructions::*;

pub mod consts;
pub mod events;
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
        deploy_fee: u64,
        buy_fee_bps: u8,
        sell_fee_bps: u8,
        token_supply: u64,
        token_threshold: u64,
        curve_a: u64,
    ) -> Result<()> {
        instructions::initialize(
            ctx,
            authority,
            fee_recipient,
            migration_account,
            deploy_fee,
            buy_fee_bps,
            sell_fee_bps,
            token_supply,
            token_threshold,
            curve_a,
        )
    }

    pub fn create(ctx: Context<Create>, name: String, symbol: String, uri: String) -> Result<()> {
        instructions::create(ctx, name, symbol, uri)
    }

    pub fn buy(ctx: Context<Trade>, sol_amount: u64, min_token_amount: u64) -> Result<()> {
        instructions::buy(ctx, sol_amount, min_token_amount)
    }

    pub fn sell(ctx: Context<Trade>, token_amount: u64, min_sol_amount: u64) -> Result<()> {
        instructions::sell(ctx, token_amount, min_sol_amount)
    }

    pub fn withdraw(ctx: Context<Withdraw>) -> Result<()> {
        instructions::withdraw(ctx)
    }
}
