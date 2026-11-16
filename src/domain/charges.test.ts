import assert from 'node:assert/strict'
import test from 'node:test'
import { calculateCharges, type ChargeRuleInput } from './charges.js'

const rules: ChargeRuleInput[] = [
  { kind: 'DELIVERY', label: 'Express delivery', mode: 'FIXED', amount: 4.5, percentBase: null, deliveryType: 'express' },
  { kind: 'DELIVERY', label: 'Standard delivery', mode: 'FIXED', amount: 0, percentBase: null, deliveryType: 'standard' },
  { kind: 'SERVICE', label: 'Dispensing', mode: 'PERCENT', amount: 10, percentBase: 'PRODUCT_SUBTOTAL', deliveryType: null },
  { kind: 'BFP', label: 'BFP', mode: 'PERCENT', amount: 5, percentBase: 'SUBTOTAL_BEFORE_BFP', deliveryType: null },
]

test('percent charges use the selected base and do not depend on later edits', () => {
  const result = calculateCharges(40, 'express', rules)
  assert.equal(result.productSubtotal, 40)
  assert.equal(result.deliveryCharge, 4.5)
  assert.equal(result.serviceCharge, 4)
  assert.equal(result.bfpCharge, 2.43)
  assert.equal(result.total, 50.93)
  assert.equal(result.lines.find((line) => line.kind === 'BFP')?.baseAmount, 48.5)
})

test('standard delivery ignores the express rule', () => {
  const result = calculateCharges(20, 'standard', rules)
  assert.equal(result.deliveryCharge, 0)
  assert.equal(result.serviceCharge, 2)
  assert.equal(result.bfpCharge, 1.1)
})

test('a delivery percent cannot use a charge that is calculated later', () => {
  assert.throws(() =>
    calculateCharges(10, 'standard', [
      { kind: 'DELIVERY', label: 'Bad', mode: 'PERCENT', amount: 5, percentBase: 'SERVICE', deliveryType: null },
    ]),
  )
})
