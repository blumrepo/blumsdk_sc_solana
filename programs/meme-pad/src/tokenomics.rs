use num_bigint::BigInt;
use num_traits::{One, ToPrimitive, Zero};

const PRECISION: u32 = 9;

pub fn calculate_token_amount(sol_amount: u64, circulating_supply: u64, curve_a: u64) -> u64 {
    let sol_reserve = f_reverse(circulating_supply, curve_a).to_u64().unwrap();
    let token_amount_bigint = f(sol_reserve + sol_amount, curve_a) - f(sol_reserve, curve_a);
    token_amount_bigint.to_u64().unwrap()
}

pub fn calculate_sol_amount(token_amount: u64, circulating_supply: u64, curve_a: u64) -> u64 {
    let sol_amount_bigint = f_reverse(circulating_supply, curve_a)
        - f_reverse(circulating_supply - token_amount, curve_a);
    sol_amount_bigint.to_u64().unwrap()
}

pub fn f(value: u64, curve_a: u64) -> BigInt {
    if value == 0 {
        return BigInt::zero();
    }

    let mult = BigInt::from(10).pow(PRECISION);
    let i = BigInt::from(value) * mult.pow(2);
    let sqrt = sqrt_bigint(&i);
    BigInt::from(curve_a) * sqrt / mult
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

fn sqrt_bigint(n: &BigInt) -> BigInt {
    if n.is_zero() {
        return BigInt::zero();
    }
    if n.is_one() {
        return BigInt::one();
    }

    let mut low = BigInt::zero();
    let mut high = n.clone();
    let mut mid;

    while low < high {
        mid = (&low + &high) >> 1;
        let mid_squared = &mid * &mid;

        if mid_squared < *n {
            low = mid + 1;
        } else if mid_squared > *n {
            high = mid;
        } else {
            return mid;
        }
    }

    low - 1
}
