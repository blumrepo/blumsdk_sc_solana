use anchor_lang::error_code;

#[error_code]
pub enum ErrorCode {
    #[msg("Calculated token amount is less than min token amount")]
    LessThanMinTokenAmount,

    #[msg("Calculated sol amount is less than min sol amount")]
    LessThanMinSolAmount,

    #[msg("Trade not allowed after threshold reached")]
    BondingCurveCompleted,

    #[msg("Withdraw not allowed before threshold reached")]
    BondingCurveNotCompleted,

    #[msg("Trade not allow for zero amount")]
    ZeroAmount,

    #[msg("Already withdrawn")]
    AlreadyWithdrawn,
}
