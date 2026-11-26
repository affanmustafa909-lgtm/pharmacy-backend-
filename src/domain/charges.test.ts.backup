import assert from 'node:assert/strict'
import test from 'node:test'
import { calculateCharges, type ChargeRuleInput } from './charges.js'
import { validateDeliveryCity } from './deliveryArea.js'

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

test('distance-based delivery charges lower fees for nearby places and raise fees for far places', () => {
  const tieredRules: ChargeRuleInput[] = [
    {
      kind: 'DELIVERY',
      label: 'Nearby (0-3 km)',
      mode: 'FIXED',
      amount: 2,
      percentBase: null,
      deliveryType: 'standard',
      minDistanceKm: 0,
      maxDistanceKm: 3,
      perKmRate: 0,
    },
    {
      kind: 'DELIVERY',
      label: 'Mid-range (3-8 km)',
      mode: 'FIXED',
      amount: 4.5,
      percentBase: null,
      deliveryType: 'standard',
      minDistanceKm: 3,
      maxDistanceKm: 8,
      perKmRate: 0,
    },
    {
      kind: 'DELIVERY',
      label: 'Far (8+ km)',
      mode: 'FIXED',
      amount: 7.5,
      percentBase: null,
      deliveryType: 'standard',
      minDistanceKm: 8,
      maxDistanceKm: null,
      perKmRate: 0.6,
    },
  ]

  const near = calculateCharges(30, 'standard', tieredRules, 1.5)
  assert.equal(near.deliveryCharge, 2)
  assert.equal(near.deliveryZoneLabel, 'Nearby (0-3 km)')

  const mid = calculateCharges(30, 'standard', tieredRules, 5.2)
  assert.equal(mid.deliveryCharge, 4.5)
  assert.equal(mid.deliveryZoneLabel, 'Mid-range (3-8 km)')

  const far = calculateCharges(30, 'standard', tieredRules, 13)
  assert.equal(far.deliveryCharge, 10.5)
  assert.equal(far.deliveryZoneLabel, 'Far (8+ km)')
})

test('out-of-city delivery orders are rejected by city mismatch or exceeding city radius', () => {
  const sameCity = validateDeliveryCity({
    storeName: 'Ali Pharmacy',
    storeCity: 'New York',
    storeCountry: 'United States',
    maxDeliveryDistanceKm: 30,
    customerCity: 'New York City',
    customerCountry: 'United States',
    distanceKm: 6.4,
  })
  assert.equal(sameCity.allowed, true)

  const otherCity = validateDeliveryCity({
    storeName: 'Ali Pharmacy',
    storeCity: 'New York',
    storeCountry: 'United States',
    maxDeliveryDistanceKm: 30,
    customerCity: 'Boston',
    customerCountry: 'United States',
    distanceKm: 12,
  })
  assert.equal(otherCity.allowed, false)
  assert.match(otherCity.reason ?? '', /out-of-city/i)

  const tooFar = validateDeliveryCity({
    storeName: 'Ali Pharmacy',
    storeCity: 'New York',
    storeCountry: 'United States',
    maxDeliveryDistanceKm: 30,
    customerCity: 'New York',
    customerCountry: 'United States',
    distanceKm: 42.5,
  })
  assert.equal(tooFar.allowed, false)
  assert.match(tooFar.reason ?? '', /30 km/i)
})
