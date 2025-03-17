use anchor_lang::prelude::*;

use crate::state::GlobalConfig;

pub fn update_config(
    ctx: Context<UpdateConfig>,
    authority: Option<Pubkey>,
    fee_recipient: Option<Pubkey>,
    migration_account: Option<Pubkey>,
    deploy_fee: Option<u64>,
    buy_fee_bps: Option<u8>,
    sell_fee_bps: Option<u8>,
    token_supply: Option<u64>,
    token_threshold: Option<u64>,
    curve_a: Option<u64>,
) -> Result<()> {
    let config = &mut ctx.accounts.global_config;

    if let Some(authority) = authority {
        config.authority = authority;
    }

    if let Some(fee_recipient) = fee_recipient {
        config.fee_recipient = fee_recipient;
    }

    if let Some(migration_account) = migration_account {
        config.migration_account = migration_account;
    }

    if let Some(deploy_fee) = deploy_fee {
        config.deploy_fee = deploy_fee;
    }

    if let Some(buy_fee_bps) = buy_fee_bps {
        config.buy_fee_bps = buy_fee_bps;
    }

    if let Some(sell_fee_bps) = sell_fee_bps {
        config.sell_fee_bps = sell_fee_bps;
    }

    if let Some(token_supply) = token_supply {
        config.token_supply = token_supply;
    }

    if let Some(token_threshold) = token_threshold {
        config.token_threshold = token_threshold;
    }

    if let Some(curve_a) = curve_a {
        config.curve_a = curve_a;
    }

    Ok(())
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [GlobalConfig::SEED_PREFIX.as_bytes()],
        bump,
    )]
    pub global_config: Box<Account<'info, GlobalConfig>>,

    pub system_program: Program<'info, System>,
}
