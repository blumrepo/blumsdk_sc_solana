use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    metadata::{
        create_metadata_accounts_v3, mpl_token_metadata::types::DataV2, CreateMetadataAccountsV3,
        Metadata,
    },
    token::{
        mint_to, set_authority, spl_token::instruction::AuthorityType::MintTokens, Mint, MintTo,
        SetAuthority, Token, TokenAccount,
    },
};

use crate::consts::{DECIMALS, DISCRIMINATOR};
use crate::state::{BondingCurve, GlobalConfig, MintAuthorityPda};

pub fn create(ctx: Context<Create>, name: String, symbol: String, uri: String) -> Result<()> {
    let mint_authority_signer_seeds: &[&[&[u8]]] =
        &[&[MintAuthorityPda::SEED_PREFIX.as_bytes(), &[ctx.bumps.mint_authority]]];

    // Create token metadata

    create_metadata_accounts_v3(
        CpiContext::new(
            ctx.accounts.token_metadata_program.to_account_info(),
            CreateMetadataAccountsV3 {
                metadata: ctx.accounts.metadata.to_account_info(),
                mint: ctx.accounts.mint_account.to_account_info(),
                mint_authority: ctx.accounts.mint_authority.to_account_info(),
                update_authority: ctx.accounts.mint_authority.to_account_info(),
                payer: ctx.accounts.user.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
                rent: ctx.accounts.rent.to_account_info(),
            },
        )
        .with_signer(mint_authority_signer_seeds),
        DataV2 {
            name,
            symbol,
            uri,
            seller_fee_basis_points: 0,
            creators: None,
            collection: None,
            uses: None,
        },
        false, // Is mutable
        true,  // Update authority is signer
        None,  // Collection details
    )?;

    // Init bonding curve

    **ctx.accounts.bonding_curve = BondingCurve {
        reserve_sol: 0,
        reserve_token: ctx.accounts.global_config.token_threshold,
        token_threshold: ctx.accounts.global_config.token_threshold,
        curve_a: ctx.accounts.global_config.curve_a
    };

    // Mint tokens to vault

    mint_to(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            MintTo {
                mint: ctx.accounts.mint_account.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.mint_authority.to_account_info(),
            },
        )
        .with_signer(mint_authority_signer_seeds),
        ctx.accounts.global_config.token_supply,
    )?;

    // Reset mint authority

    set_authority(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            SetAuthority {
                current_authority: ctx.accounts.mint_authority.to_account_info(),
                account_or_mint: ctx.accounts.mint_account.to_account_info(),
            },
        )
        .with_signer(mint_authority_signer_seeds),
        MintTokens,
        None,
    )?;

    Ok(())
}

#[derive(Accounts)]
pub struct Create<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        seeds = [GlobalConfig::SEED_PREFIX.as_bytes()],
        bump,
    )]
    pub global_config: Box<Account<'info, GlobalConfig>>,

    #[account(
        seeds = [MintAuthorityPda::SEED_PREFIX.as_bytes()],
        bump,
    )]
    pub mint_authority: Box<Account<'info, MintAuthorityPda>>,

    #[account(
        init,
        payer = user,
        mint::decimals = DECIMALS,
        mint::authority = mint_authority.key(),
    )]
    pub mint_account: Box<Account<'info, Mint>>,

    /// CHECK: Validate address by deriving pda
    #[account(
        mut,
        seeds = [b"metadata", token_metadata_program.key().as_ref(), mint_account.key().as_ref()],
        bump,
        seeds::program = token_metadata_program.key(),
    )]
    pub metadata: UncheckedAccount<'info>,

    #[account(
        init,
        payer = user,
        space = DISCRIMINATOR + BondingCurve::INIT_SPACE,
        seeds = [BondingCurve::SEED_PREFIX.as_bytes(), mint_account.key().as_ref()],
        bump,
    )]
    pub bonding_curve: Box<Account<'info, BondingCurve>>,

    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = mint_account,
        associated_token::authority = bonding_curve,
    )]
    pub vault: Box<Account<'info, TokenAccount>>,

    pub token_metadata_program: Program<'info, Metadata>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}
