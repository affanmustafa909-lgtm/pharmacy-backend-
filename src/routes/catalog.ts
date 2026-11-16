import { Router } from 'express'
import { isExpired } from '../lib/expiry.js'
import { HttpError } from '../lib/http.js'
import { prisma } from '../lib/prisma.js'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { isSellable, mapCatalogProduct } from '../services/catalogMap.js'
import { money } from '../services/money.js'
import { normalizeMobileConfig } from '../services/mobileConfig.js'

export const catalogRouter = Router()

catalogRouter.use(requireAuth, requireRole('CUSTOMER', 'ADMIN', 'STAFF'))

catalogRouter.get('/mobile-config', async (_req, res) => {
  const setting = await prisma.setting.findUnique({ where: { id: 'default' } })
  const promos = await prisma.promoCode.findMany({ where: { active: true }, orderBy: { code: 'asc' } })
  res.json({
    config: normalizeMobileConfig(setting?.mobileConfig),
    promos: promos.map((promo) => ({
      code: promo.code,
      label: promo.label,
      discount: money(promo.discount),
    })),
  })
})

catalogRouter.get('/promos/validate', async (req, res) => {
  const code = String(req.query.code ?? '').trim().toUpperCase()
  if (!code) return res.status(400).json({ message: 'Enter a promo code' })
  const promo = await prisma.promoCode.findFirst({ where: { code, active: true } })
  if (!promo) return res.status(404).json({ message: 'Promo code not found' })
  res.json({ code: promo.code, label: promo.label, discount: money(promo.discount) })
})

catalogRouter.get('/stores', async (_req, res) => {
  const stores = await prisma.store.findMany({ where: { isOpen: true }, orderBy: { name: 'asc' } })
  res.json({
    stores: stores.map((store) => ({
      id: store.id,
      code: store.code,
      name: store.name,
      address: store.address,
      openUntil: store.openUntil,
      rating: store.rating,
      phone: store.phone,
      pharmacist: store.pharmacist,
    })),
  })
})

catalogRouter.get('/categories', async (_req, res) => {
  const rows = await prisma.product.findMany({
    where: { held: false, onlineSale: true, published: true, stock: { gt: 0 } },
    select: { category: true },
    distinct: ['category'],
    orderBy: { category: 'asc' },
  })
  res.json({ categories: rows.map((row) => row.category).filter(Boolean) })
})

catalogRouter.get('/strengths', async (req, res) => {
  const storeId = String(req.query.storeId ?? '').trim()
  const rows = await prisma.product.findMany({
    where: {
      held: false,
      onlineSale: true,
      published: true,
      strength: { not: '' },
      ...(storeId ? { storeId } : {}),
    },
    select: { strength: true },
    distinct: ['strength'],
    orderBy: { strength: 'asc' },
  })
  res.json({ strengths: rows.map((row) => row.strength).filter(Boolean) })
})

catalogRouter.get('/suggest', async (req, res) => {
  const q = String(req.query.q ?? '').trim()
  if (q.length < 1) return res.json({ suggestions: [] })
  const products = await prisma.product.findMany({
    where: {
      held: false,
      onlineSale: true,
      published: true,
      OR: [
        { name: { contains: q, mode: 'insensitive' } },
        { brand: { contains: q, mode: 'insensitive' } },
        { genericName: { contains: q, mode: 'insensitive' } },
        { strength: { contains: q, mode: 'insensitive' } },
      ],
    },
    select: { name: true, brand: true, genericName: true, strength: true, sku: true },
    take: 40,
  })
  const seen = new Set<string>()
  const suggestions: { type: string; label: string; q: string }[] = []
  for (const product of products) {
    for (const [type, label] of [
      ['name', product.name],
      ['brand', product.brand],
      ['generic', product.genericName],
    ] as const) {
      const value = label.trim()
      if (!value) continue
      if (!value.toLowerCase().includes(q.toLowerCase())) continue
      const key = `${type}:${value.toLowerCase()}`
      if (seen.has(key)) continue
      seen.add(key)
      suggestions.push({ type, label: value, q: value })
      if (suggestions.length >= 8) break
    }
    if (suggestions.length >= 8) break
  }
  res.json({ suggestions })
})

catalogRouter.get('/products', async (req, res) => {
  const q = String(req.query.q ?? '').trim()
  const storeId = String(req.query.storeId ?? '').trim()
  const category = String(req.query.category ?? '').trim()
  const strength = String(req.query.strength ?? '').trim()
  const inStockRaw = String(req.query.inStock ?? '').trim().toLowerCase()
  const setting = await prisma.setting.findUnique({ where: { id: 'default' } })
  const showOutOfStock = setting?.showOutOfStock ?? true
  const products = await prisma.product.findMany({
    where: {
      held: false,
      onlineSale: true,
      published: true,
      ...(storeId ? { storeId } : {}),
      ...(category ? { category } : {}),
      ...(strength ? { strength: { equals: strength, mode: 'insensitive' } } : {}),
      ...(inStockRaw === 'true' || (!showOutOfStock && inStockRaw !== 'false') ? { stock: { gt: 0 } } : {}),
      ...(inStockRaw === 'false' ? { stock: { lte: 0 } } : {}),
      ...(q
        ? {
            OR: [
              { name: { contains: q, mode: 'insensitive' } },
              { brand: { contains: q, mode: 'insensitive' } },
              { genericName: { contains: q, mode: 'insensitive' } },
              { strength: { contains: q, mode: 'insensitive' } },
              { category: { contains: q, mode: 'insensitive' } },
              { sku: { contains: q, mode: 'insensitive' } },
            ],
          }
        : {}),
    },
    include: { store: true },
    orderBy: { name: 'asc' },
    take: 100,
  })
  const mapped = products
    .filter((product) => !isExpired(product.expiry) || showOutOfStock)
    .map(mapCatalogProduct)
    .filter((product) => {
      if (inStockRaw === 'true') return product.inStock
      if (inStockRaw === 'false') return !product.inStock
      return true
    })
  res.json({ products: mapped })
})

catalogRouter.get('/products/:id', async (req, res, next) => {
  try {
    const product = await prisma.product.findUnique({
      where: { id: req.params.id },
      include: { store: true },
    })
    if (!product || product.held || !product.onlineSale || !product.published) {
      throw new HttpError(404, 'Product not found')
    }
    res.json({ product: mapCatalogProduct(product) })
  } catch (error) {
    next(error)
  }
})

catalogRouter.get('/products/:id/availability', async (req, res, next) => {
  try {
    const product = await prisma.product.findUnique({ where: { id: req.params.id } })
    if (!product) throw new HttpError(404, 'Product not found')
    const rows = await prisma.product.findMany({
      where: {
        sku: product.sku,
        held: false,
        onlineSale: true,
        published: true,
        store: { isOpen: true, status: 'active', acceptingOrders: true },
      },
      include: { store: true },
      orderBy: { price: 'asc' },
    })
    res.json({
      sku: product.sku,
      stores: rows.map((row) => {
        const expired = isExpired(row.expiry)
        return {
          productId: row.id,
          storeId: row.storeId,
          storeName: row.store.name,
          address: row.store.address,
          openUntil: row.store.openUntil,
          price: money(row.price),
          stock: row.stock,
          inStock: row.stock > 0 && !expired,
          expired,
          expiry: row.expiry,
          batch: row.batch,
        }
      }),
    })
  } catch (error) {
    next(error)
  }
})

catalogRouter.post('/products/:id/notify', async (req, res, next) => {
  try {
    const product = await prisma.product.findUnique({ where: { id: req.params.id }, include: { store: true } })
    if (!product) throw new HttpError(404, 'Product not found')
    if (!isSellable(product) && product.stock > 0) throw new HttpError(400, 'This product cannot be ordered')
    const alert = await prisma.stockAlert.upsert({
      where: {
        customerId_storeId_sku: {
          customerId: req.user!.id,
          storeId: product.storeId,
          sku: product.sku,
        },
      },
      create: {
        customerId: req.user!.id,
        storeId: product.storeId,
        productId: product.id,
        sku: product.sku,
        productName: product.name,
        active: true,
      },
      update: {
        productId: product.id,
        productName: product.name,
        active: true,
      },
    })
    res.status(201).json({
      id: alert.id,
      sku: alert.sku,
      storeId: alert.storeId,
      productName: alert.productName,
      active: alert.active,
    })
  } catch (error) {
    next(error)
  }
})

catalogRouter.delete('/products/:id/notify', async (req, res, next) => {
  try {
    const product = await prisma.product.findUnique({ where: { id: req.params.id } })
    if (!product) throw new HttpError(404, 'Product not found')
    await prisma.stockAlert.updateMany({
      where: { customerId: req.user!.id, storeId: product.storeId, sku: product.sku, active: true },
      data: { active: false },
    })
    res.json({ ok: true })
  } catch (error) {
    next(error)
  }
})
