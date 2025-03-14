const PRECISION = 9n

export class Tokenomics {
  #curveA: bigint

  constructor(curveA: bigint) {
    this.#curveA = curveA
  }

  #sqrt(n: bigint): bigint {
    let x = n
    let y = (x + 1n) >> 1n
    while (y < x) {
      x = y
      y = (x + n / x) >> 1n
    }
    return x
  }

  #f(value: bigint) {
    if (value == 0n) {
      return 0n
    }

    const mult = 10n ** PRECISION
    const sqrtValue = this.#sqrt(value * mult * mult)
    return (sqrtValue * this.#curveA) / mult
  }

  #fReverse(value: bigint) {
    if (value == 0n) {
      return 0n
    }

    const mult = 10n ** PRECISION
    const sqrValue = value ** 2n * mult
    return sqrValue / this.#curveA ** 2n / mult
  }

  calculateSolAmountForBuy(supply: bigint, tokenAmount: bigint) {
    return this.#fReverse(supply) - this.#fReverse(supply - tokenAmount) + 1n
  }

  calculateSolAmountForSell(supply: bigint, tokenAmount: bigint) {
    const amount = this.#fReverse(supply) - this.#fReverse(supply - tokenAmount)
    return amount > 0n ? amount - 1n : amount
  }

  calculateTokenAmount(supply: bigint, threshold: bigint, solAmount: bigint) {
    const solReserve = this.#fReverse(supply)
    const tokenAmount = this.#f(solReserve + solAmount) - this.#f(solReserve)
    return tokenAmount + supply > threshold ? threshold - supply : tokenAmount
  }
}
