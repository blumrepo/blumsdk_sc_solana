use num_bigint::BigInt;
use num_traits::{ToPrimitive, Zero};

const PRECISION: u32 = 9;

pub fn calculate_sol_amount_for_buy(token_amount: u64, circulating_supply: u64, curve_a: u64) -> u64 {
    let sol_amount_bigint = f_reverse(circulating_supply + token_amount, curve_a) - f_reverse(circulating_supply, curve_a);
    sol_amount_bigint.to_u64().unwrap()
}

pub fn calculate_sol_amount_for_sell(token_amount: u64, circulating_supply: u64, curve_a: u64) -> u64 {
    let sol_amount_bigint = f_reverse(circulating_supply, curve_a) - f_reverse(circulating_supply - token_amount, curve_a);
    sol_amount_bigint.to_u64().unwrap()
}

pub fn f_reverse(value: u64, curve_a: u64) -> BigInt {
    if value == 0 {
        return BigInt::zero();
    }

    let mult = BigInt::from(10).pow(PRECISION);
    let sqr = BigInt::from(value).pow(2) * &mult;
    let curve_a_squared = BigInt::from(curve_a).pow(2);
    (sqr / curve_a_squared) / mult
}
