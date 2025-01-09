import { Assertion } from 'chai'

Assertion.addMethod('closeToBigInt', function (expected: bigint, delta: bigint) {
  const actual: bigint = this._obj
  const diff = actual > expected ? actual - expected : expected - actual
  this.assert(
    diff <= delta,
    `expected #{act} to be close to #{exp} +/- ${delta} (actual delta: ${diff})`,
    `expected #{act} not to be close to #{exp} +/- ${delta} (actual delta: ${diff})`,
    expected,
    actual
  )
})
