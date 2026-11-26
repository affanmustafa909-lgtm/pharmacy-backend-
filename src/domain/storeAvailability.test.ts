import test from 'node:test'
import assert from 'node:assert/strict'
import { getStoreOrderEligibility } from './storeAvailability.js'

const baseStore = {
  status: 'active',
  isOpen: true,
  acceptingOrders: true,
  weeklyHours: {
    mon: { open: '09:00', close: '22:00' },
    tue: { open: '09:00', close: '22:00' },
    wed: { open: '09:00', close: '22:00' },
    thu: { open: '09:00', close: '22:00' },
    fri: { open: '09:00', close: '22:00' },
    sat: { open: '10:00', close: '20:00' },
    sun: { open: '10:00', close: '18:00' },
  },
  closedDays: [],
  holidayHours: [],
}

test('draft store cannot accept orders', () => {
  const result = getStoreOrderEligibility(
    { ...baseStore, status: 'draft' },
    new Date('2026-11-23T05:00:00.000Z'),
  )
  assert.equal(result.eligible, false)
  assert.equal(result.reason, 'Not published')
})

test('paused store cannot accept orders', () => {
  const result = getStoreOrderEligibility(
    { ...baseStore, status: 'paused' },
    new Date('2026-11-23T05:00:00.000Z'),
  )
  assert.equal(result.eligible, false)
  assert.equal(result.reason, 'Temporarily paused')
})

test('manually closed store cannot accept orders', () => {
  const result = getStoreOrderEligibility(
    { ...baseStore, isOpen: false },
    new Date('2026-11-23T05:00:00.000Z'),
  )
  assert.equal(result.eligible, false)
  assert.equal(result.reason, 'Currently closed')
})

test('store not accepting orders is blocked', () => {
  const result = getStoreOrderEligibility(
    { ...baseStore, acceptingOrders: false },
    new Date('2026-11-23T05:00:00.000Z'),
  )
  assert.equal(result.eligible, false)
  assert.equal(result.reason, 'Not accepting orders')
})

test('orders are allowed at opening time in Pakistan', () => {
  const result = getStoreOrderEligibility(
    baseStore,
    new Date('2026-11-23T04:00:00.000Z'),
  )
  assert.equal(result.eligible, true)
  assert.equal(result.reason, null)
})

test('orders are blocked before opening time in Pakistan', () => {
  const result = getStoreOrderEligibility(
    baseStore,
    new Date('2026-11-23T03:59:00.000Z'),
  )
  assert.equal(result.eligible, false)
  assert.match(result.reason ?? '', /working hours|opens/i)
})

test('orders are blocked at closing time in Pakistan', () => {
  const result = getStoreOrderEligibility(
    baseStore,
    new Date('2026-11-23T17:00:00.000Z'),
  )
  assert.equal(result.eligible, false)
  assert.match(result.reason ?? '', /working hours|closed/i)
})

test('closed day blocks orders', () => {
  const result = getStoreOrderEligibility(
    { ...baseStore, closedDays: ['mon'] },
    new Date('2026-11-23T05:00:00.000Z'),
  )
  assert.equal(result.eligible, false)
})

test('holiday closure blocks orders', () => {
  const result = getStoreOrderEligibility(
    {
      ...baseStore,
      holidayHours: [{ date: '2026-11-23', closed: true }],
    },
    new Date('2026-11-23T05:00:00.000Z'),
  )
  assert.equal(result.eligible, false)
})

test('holiday hours override normal weekly hours', () => {
  const result = getStoreOrderEligibility(
    {
      ...baseStore,
      holidayHours: [{ date: '2026-11-23', open: '12:00', close: '14:00' }],
    },
    new Date('2026-11-23T05:00:00.000Z'),
  )
  assert.equal(result.eligible, false)
})

test('overnight hours stay open before midnight', () => {
  const result = getStoreOrderEligibility(
    {
      ...baseStore,
      weeklyHours: {
        ...baseStore.weeklyHours,
        mon: { open: '20:00', close: '02:00' },
      },
    },
    new Date('2026-11-23T16:00:00.000Z'), // Monday 21:00 PKT
  )
  assert.equal(result.eligible, true)
})

test('full weekday keys are accepted', () => {
  const result = getStoreOrderEligibility(
    {
      ...baseStore,
      weeklyHours: {
        monday: { open: '09:00', close: '22:00' },
      },
    },
    new Date('2026-11-23T05:00:00.000Z'),
  )
  assert.equal(result.eligible, true)
})
