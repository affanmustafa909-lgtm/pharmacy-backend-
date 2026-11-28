// Run from the backend folder:
//   $env:TOKEN="your token"
//   node --env-file=.env scripts/check-analytics.mjs
// Compares the analytics numbers with the real order records in the database.
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const API = process.env.API ?? 'http://localhost:4000'
const BASE = process.env.ANALYTICS_PATH ?? '/admin/analytics'
const TOKEN = process.env.TOKEN
if (!TOKEN) {
  console.log('Set TOKEN first:  $env:TOKEN="your token"')
  process.exit(1)
}

const call = async (path) => {
  const res = await fetch(API + path, { headers: { Authorization: `Bearer ${TOKEN}` } })
  return { status: res.status, json: await res.json().catch(() => ({})) }
}
let failed = 0
const check = (name, ok, extra = '') => {
  console.log(ok ? 'PASS' : 'FAIL', '-', name, ok ? '' : JSON.stringify(extra))
  if (!ok) failed++
}

try {
  const latest = await prisma.order.findFirst({ orderBy: { createdAt: 'desc' }, select: { storeId: true } })
  const storeId = process.env.STORE ?? latest?.storeId
  if (!storeId) throw new Error('No orders in the database yet. Place an order from the app first.')

  const day = (d) => new Date(Date.now() + 5 * 3600e3 - d * 86400e3).toISOString().slice(0, 10)
  const from = day(300)
  const to = day(0)
  const start = new Date(`${from}T00:00:00+05:00`)
  const end = new Date(`${to}T23:59:59.999+05:00`)
  const q = `storeId=${storeId}&from=${from}&to=${to}&limit=50`
  console.log(`Store ${storeId}, period ${from} to ${to}\n`)

  const top = await call(`${BASE}/top-products?${q}`)
  const hrs = await call(`${BASE}/peak-hours?${q}`)
  check('top-products endpoint works', top.status === 200, top.json)
  check('peak-hours endpoint works', hrs.status === 200, hrs.json)

  const where = { storeId, createdAt: { gte: start, lte: end }, status: { not: 'cancelled' } }

  // every product row must match the real order items
  let allMatch = true
  for (const p of top.json.products ?? []) {
    const real = await prisma.orderItem.aggregate({
      _sum: { quantity: true },
      where: { sku: p.sku, name: p.name, order: where },
    })
    if ((real._sum.quantity ?? 0) !== p.units) {
      allMatch = false
      console.log('   mismatch', p.sku, 'endpoint', p.units, 'database', real._sum.quantity)
    }
  }
  check('top products units match the order items', allMatch)

  // all hours together must equal the number of non-cancelled orders
  const orderCount = await prisma.order.count({ where })
  const hourTotal = (hrs.json.hours ?? []).reduce((s, h) => s + h.orders, 0)
  check(`peak hours add up to ${orderCount} orders`, hourTotal === orderCount, { hourTotal, orderCount })
  check('24 hours returned', (hrs.json.hours ?? []).length === 24)

  console.log('   top 3 busy hours:', JSON.stringify((hrs.json.peak ?? []).map((h) => `${h.label} (${h.orders})`)))

  // bad input must be rejected
  const bad = await call(`${BASE}/top-products?storeId=${storeId}&from=2026-13-45`)
  check('bad date is rejected', bad.status === 400, bad.json)
} catch (e) {
  console.log('ERROR', e.message)
  failed++
} finally {
  await prisma.$disconnect()
}
console.log(failed ? `\n${failed} check(s) FAILED` : '\nALL CHECKS PASSED')