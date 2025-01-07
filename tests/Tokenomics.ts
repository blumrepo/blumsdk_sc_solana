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

  calculateSolAmountForBuy(supply: bigint, amount: bigint) {
    return this.#fReverse(supply + amount) - this.#fReverse(supply)
  }

  calculateSolAmountForSell(supply: bigint, amount: bigint) {
    return this.#fReverse(supply) - this.#fReverse(supply - amount)
  }

  calculateTokenAmount(totalSupply: bigint, solAmount: bigint) {
    const solReserve = this.#fReverse(totalSupply)
    return this.#f(solReserve + solAmount) - this.#f(solReserve)
  }
}
