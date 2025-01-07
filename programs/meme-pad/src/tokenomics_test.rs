#[cfg(test)]
mod tests {
    use crate::tokenomics::*;

    const THRESHOLD_SOLS: u64 = 84__999_999_999;
    const THRESHOLD_SUPPLY: u64 = 793_099_999__845_341;
    const CURVE_A: u64 = 2_720_310_557;

    #[test]
    fn calculate_sol_amount_for_sell_1() {
        let token_amount = THRESHOLD_SUPPLY;
        let circulating_supply = THRESHOLD_SUPPLY;
        let sol_amount = calculate_sol_amount_for_sell(token_amount, circulating_supply, CURVE_A);

        assert_eq!(sol_amount, THRESHOLD_SOLS);
    }

    #[test]
    #[should_panic(expected = "attempt to subtract with overflow")]
    fn calculate_sol_amount_for_sell_2() {
        let token_amount = THRESHOLD_SUPPLY;
        let circulating_supply = 0;
        let sol_amount = calculate_sol_amount_for_sell(token_amount, circulating_supply, CURVE_A);

        assert_eq!(sol_amount, THRESHOLD_SOLS);
    }

    #[test]
    fn calculate_sol_amount_for_sell_3() {
        let token_amount = 5000_000_000;
        let circulating_supply = 5000_000_000;
        let sol_amount = calculate_sol_amount_for_sell(token_amount, circulating_supply, CURVE_A);

        assert_eq!(sol_amount, 3);
    }

    #[test]
    #[should_panic(expected = "attempt to subtract with overflow")]
    fn calculate_sol_amount_for_sell_4() {
        let token_amount = 5000_000_000;
        let circulating_supply = 0;
        let sol_amount = calculate_sol_amount_for_sell(token_amount, circulating_supply, CURVE_A);
    }

    #[test]
    fn calculate_sol_amount_for_buy_1() {
        let token_amount = THRESHOLD_SUPPLY;
        let circulating_supply = 0u64;
        let sol_amount = calculate_sol_amount_for_buy(token_amount, circulating_supply, CURVE_A);

        assert_eq!(sol_amount, THRESHOLD_SOLS);
    }

    #[test]
    fn calculate_sol_amount_for_buy_2() {
        let token_amount = 1_785_357_737_104;
        let circulating_supply = 0u64;
        let sol_amount = calculate_sol_amount_for_buy(token_amount, circulating_supply, CURVE_A);

        assert_eq!(sol_amount, 430738);
    }

    #[test]
    fn calculate_sol_amount_for_buy_3() {
        let token_amount = 5_000_000_000;
        let circulating_supply = 0u64;
        let sol_amount = calculate_sol_amount_for_buy(token_amount, circulating_supply, CURVE_A);

        assert_eq!(sol_amount, 3);
    }
}
