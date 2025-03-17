use anchor_lang::event;
use anchor_lang::prelude::*;

#[event]
pub struct BuyEvent {
    pub buyer: Pubkey,
    pub sol_amount: u64,
    pub token_amount: u64,
    pub reserve_sol: u64,
    pub reserve_token: u64,
}

#[event]
pub struct SellEvent {
    pub seller: Pubkey,
    pub sol_amount: u64,
    pub token_amount: u64,
    pub reserve_sol: u64,
    pub reserve_token: u64,
}
