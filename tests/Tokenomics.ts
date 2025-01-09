import { LAMPORTS_PER_SOL } from '@solana/web3.js'

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

  calculateTokenAmount(circulatingSupply: bigint, solAmount: bigint) {
    const solReserve = this.#fReverse(circulatingSupply)
    return this.#f(solReserve + solAmount) - this.#f(solReserve)
  }

  calculateSolAmount(circulatingSupply: bigint, tokenAmount: bigint) {
    return this.#fReverse(circulatingSupply) - this.#fReverse(circulatingSupply - tokenAmount)
  }

  calculatePrice(circulatingSupply: bigint) {
    const one = LAMPORTS_PER_SOL
    const amountForOneSol = this.calculateTokenAmount(circulatingSupply, BigInt(one))
    return one / Number(amountForOneSol)
  }
}
