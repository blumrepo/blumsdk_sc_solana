import 'chai'

declare global {
  namespace Chai {
    interface Assertion {
      closeToBigInt(expected: bigint, delta: bigint): Assertion
    }
  }
}
