// Run from the backend folder:
//   $env:TOKEN="your token"
//   node --env-file=.env scripts/check-stock.mjs
// Stores and SKU are picked automatically from the database.
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const API = process.env.API ?? 'http://localhost:4000'
const STOCK = process.env.STOCK_PATH ?? '/admin/stock'
const PUR = process.env.PURCHASING_PATH ?? '/admin/purchasing'
const TOKEN = process.env.TOKEN
if (!TOKEN) {
  console.log('Set TOKEN first:  $env:TOKEN="your token"')
  process.exit(1)
}

// pick a SKU that exists in 2 stores
const shared = await prisma.product.groupBy({ by: ['sku'], having: { storeId: { _count: { gt: 1 } } } })
if (!process.env.SKU && !shared.length) {
  console.log('No SKU exists in 2 stores. Duplicate one product into a second store, then run again.')
  await prisma.$disconnect()
  process.exit(1)
}
const SKU = process.env.SKU ?? shared[0].sku
const rows = await prisma.product.findMany({ where: { sku: SKU }, select: { storeId: true } })
const STORE = process.env.STORE ?? rows[0].storeId
const STORE2 = process.env.STORE2 ?? rows[1].storeId
console.log(`Testing with SKU ${SKU}, store ${STORE}, store2 ${STORE2}\n`)

async function call(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, json: await res.json().catch(() => ({})) }
}
let failed = 0
const check = (name, ok, extra = '') => {
  console.log(ok ? 'PASS' : 'FAIL', '-', name, ok ? '' : JSON.stringify(extra))
  if (!ok) failed++
}
const product = (storeId) => prisma.product.findUnique({ where: { storeId_sku: { storeId, sku: SKU } } })
const stock = async (storeId) => (await product(storeId)).stock
const ts = Date.now()

try {
  const p1 = await product(STORE)

  // 1) Restock +5, sent twice with the same requestId
  let before = await stock(STORE)
  const adj = { quantity: 5, reason: 'restock', note: 'check restock', requestId: `chk-r-${ts}` }
  const first = await call('POST', `${STOCK}/${p1.id}/adjust`, adj)
  const again = await call('POST', `${STOCK}/${p1.id}/adjust`, adj)
  check('restock +5 applied once (retry is ignored)', (await stock(STORE)) === before + 5 && again.json.repeated === true, first)

  // 2) Write-off 2, sent twice
  before = await stock(STORE)
  const wo = { quantity: 2, reason: 'damage', note: 'check write-off', requestId: `chk-w-${ts}`, unitCost: 10 }
  await call('POST', `${STOCK}/${p1.id}/adjust`, wo)
  await call('POST', `${STOCK}/${p1.id}/adjust`, wo)
  check('write-off -2 applied once', (await stock(STORE)) === before - 2)

  // 3) Supplier + purchase receiving
  const sup = await call('POST', `${PUR}/suppliers`, { storeId: STORE, name: `Check Supplier ${ts}`, contact: '0300', address: 'x' })
  check('supplier created', sup.status === 201, sup.json)
  const supplierId = sup.json.supplier?.id
  const line = { sku: SKU, batchNumber: `CHK-${ts}`, expiry: '2027-12-31', quantity: 10, unitCost: 100 }
  const inv = await call('POST', `${PUR}/purchases`, { storeId: STORE, supplierId, number: `CHK-${ts}`, lines: [line] })
  check('draft invoice created', inv.status === 201, inv.json)
  const invId = inv.json.invoice?.id
  before = await stock(STORE)
  await call('POST', `${PUR}/purchases/${invId}/receive`)
  await call('POST', `${PUR}/purchases/${invId}/receive`)
  check('receive 10 => +10, repeat => +0', (await stock(STORE)) === before + 10)

  const d2 = await call('POST', `${PUR}/purchases`, { storeId: STORE, supplierId, number: `CHK2-${ts}`, lines: [line] })
  before = await stock(STORE)
  await call('POST', `${PUR}/purchases/${d2.json.invoice?.id}/cancel`)
  check('draft/cancel: stock unchanged', before === (await stock(STORE)))

  // 4) Payments: 1000 invoice, 400 paid => 600 pending
  const pay = { amount: 400, receiptRef: `RC-${ts}` }
  await call('POST', `${PUR}/purchases/${invId}/payments`, pay)
  const pay2 = await call('POST', `${PUR}/purchases/${invId}/payments`, pay)
  check('total 1000, paid 400, balance 600 (retry safe)', pay2.json.total === 1000 && pay2.json.paid === 400 && pay2.json.balance === 600, pay2.json)
  const over = await call('POST', `${PUR}/purchases/${invId}/payments`, { amount: 700, receiptRef: `RC2-${ts}` })
  check('payment above balance is rejected', over.status === 400, over.json)

  // 5) Transfer: dispatch 3 from STORE, receive in STORE2 (twice)
  const s1 = await stock(STORE)
  const s2 = await stock(STORE2)
  const disp = { fromStoreId: STORE, toStoreId: STORE2, sku: SKU, batchNumber: `CHK-${ts}`, quantity: 3, requestId: `chk-t-${ts}` }
  const t = await call('POST', `${PUR}/transfers/dispatch`, disp)
  await call('POST', `${PUR}/transfers/dispatch`, disp)
  check('dispatch 3 => source -3 (retry ignored)', (await stock(STORE)) === s1 - 3, t.json)
  const tid = t.json.transfer?.id
  await call('POST', `${PUR}/transfers/${tid}/receive`)
  await call('POST', `${PUR}/transfers/${tid}/receive`)
  check('receive => destination +3 once', (await stock(STORE2)) === s2 + 3)

  // 6) Expiry counts
  const ex = await call('GET', `${STOCK}/expiry-summary?storeId=${STORE}`)
  check('expiry summary works', ex.status === 200 && typeof ex.json.expired === 'number', ex.json)
  console.log('   expiry summary:', JSON.stringify(ex.json))
} catch (e) {
  console.log('ERROR', e.message)
  failed++
} finally {
  await prisma.$disconnect()
}
console.log(failed ? `\n${failed} check(s) FAILED` : '\nALL CHECKS PASSED')