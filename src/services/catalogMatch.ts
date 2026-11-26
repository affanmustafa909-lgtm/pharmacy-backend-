import { prisma } from '../lib/prisma.js'
import { money } from './money.js'

export type DetectedMedicine = {
  name?: string
  strength?: string
  form?: string
  packSize?: string
  confidence?: number
  unclear?: boolean
}

export type CatalogMatch = {
  productId: string
  storeId: string
  storeName: string
  sku: string
  name: string
  genericName: string
  strength: string
  form: string
  packSize: string
  price: number
  stock: number
  inStock: boolean
  rxRequired: boolean
  score: number
}

function normalize(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s.+%-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function tokenScore(query: string, haystack: string) {
  if (!query || !haystack) return 0
  if (haystack.includes(query) || query.includes(haystack)) return 1
  const qTokens = query.split(' ').filter((t) => t.length > 1)
  if (!qTokens.length) return 0
  const hits = qTokens.filter((token) => haystack.includes(token)).length
  return hits / qTokens.length
}

/** Score a catalog product against customer-confirmed / detected medicine details. */
export function scoreProduct(
  detected: DetectedMedicine,
  product: {
    name: string
    genericName: string
    strength: string
    unitLabel: string
    category: string
  },
) {
  const nameQ = normalize(detected.name ?? '')
  const strengthQ = normalize(detected.strength ?? '')
  const formQ = normalize(detected.form ?? '')
  const packQ = normalize(detected.packSize ?? '')

  const nameHay = normalize(`${product.name} ${product.genericName}`)
  const strengthHay = normalize(product.strength)
  const packHay = normalize(product.unitLabel)
  const formHay = normalize(`${product.unitLabel} ${product.category}`)

  let score = 0
  score += tokenScore(nameQ, nameHay) * 0.55
  if (strengthQ) score += tokenScore(strengthQ, strengthHay) * 0.25
  if (packQ) score += tokenScore(packQ, packHay) * 0.12
  if (formQ) score += tokenScore(formQ, formHay) * 0.08

  if (!nameQ) return 0
  return Math.round(score * 1000) / 1000
}

/**
 * Lightweight “identification” from optional OCR/hint text when a full ML OCR
 * stack is not installed. Returns candidate fields the customer can confirm.
 */
export function extractCandidatesFromText(text: string): DetectedMedicine {
  const raw = text.trim()
  if (!raw || raw.length < 3) {
    return { unclear: true, confidence: 0 }
  }

  const strength =
    raw.match(/\b(\d+(?:\.\d+)?\s?(?:mg|mcg|g|ml|iu|%)\b)/i)?.[1]?.trim() ?? ''
  const formMatch = raw.match(
    /\b(tablet|tablets|capsule|capsules|syrup|cream|ointment|drops|injection|inhaler|patch|suspension)\b/i,
  )
  const packMatch = raw.match(/\b(\d+\s?(?:tablets?|capsules?|ml|g)\b)/i)

  // Prefer a line that looks like a medicine title (short, not a sig line).
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.replace(/^(medicine|rx|drug)\s*[:\-]\s*/i, '').trim())
    .filter(Boolean)
  const nameLine =
    lines.find(
      (line) =>
        line.length >= 3 &&
        line.length <= 60 &&
        !/^(patient|sig|take|prescriber|dr\.|qty)/i.test(line),
    ) ?? lines[0] ??
    raw.slice(0, 60)

  const name = nameLine.replace(strength, '').replace(/\s{2,}/g, ' ').trim() || nameLine

  return {
    name,
    strength,
    form: formMatch?.[1]?.toLowerCase() ?? '',
    packSize: packMatch?.[1] ?? '',
    confidence: strength || formMatch ? 0.62 : 0.4,
    unclear: name.length < 3,
  }
}

export async function matchCatalog(input: {
  storeId?: string
  detected: DetectedMedicine
  limit?: number
}): Promise<CatalogMatch[]> {
  const detected = input.detected
  if (!detected.name?.trim() || detected.unclear) return []

  const products = await prisma.product.findMany({
    where: {
      published: true,
      held: false,
      onlineSale: true,
      ...(input.storeId ? { storeId: input.storeId } : {}),
    },
    include: { store: { select: { id: true, name: true, status: true, acceptingOrders: true } } },
    take: 400,
  })

  const scored = products
    .map((product) => {
      const score = scoreProduct(detected, product)
      return {
        productId: product.id,
        storeId: product.storeId,
        storeName: product.store.name,
        sku: product.sku,
        name: product.name,
        genericName: product.genericName,
        strength: product.strength,
        form: product.category,
        packSize: product.unitLabel,
        price: money(product.price),
        stock: product.stock,
        inStock: product.stock > 0,
        rxRequired: product.rxRequired,
        score,
      }
    })
    .filter((row) => row.score >= 0.35)
    .sort((a, b) => b.score - a.score || b.stock - a.stock)

  const limit = Math.min(input.limit ?? 8, 20)
  // Deduplicate by SKU preferring the requested store, then in-stock.
  const bySku = new Map<string, CatalogMatch>()
  for (const row of scored) {
    const existing = bySku.get(row.sku)
    if (!existing) {
      bySku.set(row.sku, row)
      continue
    }
    const prefer =
      (input.storeId && row.storeId === input.storeId && existing.storeId !== input.storeId) ||
      (row.inStock && !existing.inStock) ||
      row.score > existing.score
    if (prefer) bySku.set(row.sku, row)
  }

  return Array.from(bySku.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}

export async function stockAcrossStores(input: {
  sku: string
  excludeStoreId?: string
}) {
  const products = await prisma.product.findMany({
    where: {
      sku: input.sku,
      published: true,
      held: false,
      onlineSale: true,
      stock: { gt: 0 },
      store: { status: 'active', acceptingOrders: true, isOpen: true },
      ...(input.excludeStoreId ? { storeId: { not: input.excludeStoreId } } : {}),
    },
    include: { store: true },
    orderBy: { stock: 'desc' },
    take: 12,
  })

  return products.map((product) => ({
    productId: product.id,
    storeId: product.storeId,
    storeName: product.store.name,
    address: product.store.address,
    openUntil: product.store.openUntil,
    sku: product.sku,
    name: product.name,
    price: money(product.price),
    stock: product.stock,
    inStock: true,
    rxRequired: product.rxRequired,
  }))
}
