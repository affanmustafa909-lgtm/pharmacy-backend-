
import { Router } from 'express'
import { isExpired } from '../lib/expiry.js'
import { HttpError } from '../lib/http.js'
import { prisma } from '../lib/prisma.js'
import { optionalAuth, requireAuth, requireRole } from '../middleware/auth.js'
import { isSellable, mapCatalogProduct } from '../services/catalogMap.js'
import { DEFAULT_MAX_DELIVERY_DISTANCE_KM, resolveStoreCity } from '../domain/deliveryArea.js'
import { filterStoresAvailableToCustomer } from '../services/availableStores.js'
import { getStoreOrderEligibility } from '../domain/storeAvailability.js'
import { money } from '../services/money.js'
import { normalizeMobileConfig } from '../services/mobileConfig.js'
import { sellableStock } from '../services/inventory.js'

export const catalogRouter = Router()

catalogRouter.get('/mobile-config', async (_req, res, next) => {
  try {
    const setting = await prisma.setting.findUnique({
      where: { id: 'default' },
    })

    const promos = await prisma.promoCode.findMany({
      where: { active: true },
      orderBy: { code: 'asc' },
    })

    res.json({
      config: normalizeMobileConfig(setting?.mobileConfig),
      promos: promos.map((promo) => ({
        code: promo.code,
        label: promo.label,
        discount: money(promo.discount),
      })),
    })
  } catch (error) {
    next(error)
  }
})

catalogRouter.get('/promos/validate', async (req, res, next) => {
  try {
    const code = String(req.query.code ?? '').trim().toUpperCase()

    if (!code) {
      return res.status(400).json({ message: 'Enter a promo code' })
    }

    const promo = await prisma.promoCode.findFirst({
      where: { code, active: true },
    })

    if (!promo) {
      return res.status(404).json({ message: 'Promo code not found' })
    }

    res.json({
      code: promo.code,
      label: promo.label,
      discount: money(promo.discount),
    })
  } catch (error) {
    next(error)
  }
})

catalogRouter.get('/stores', optionalAuth, async (req, res, next) => {
  try {
    const addressId = String(req.query.addressId ?? '').trim() || undefined
    const latitudeRaw = String(req.query.lat ?? '').trim()
    const longitudeRaw = String(req.query.lng ?? '').trim()
    const latitude = latitudeRaw ? Number(latitudeRaw) : null
    const longitude = longitudeRaw ? Number(longitudeRaw) : null

    const stores = await prisma.store.findMany({
      where: req.user?.role === 'CUSTOMER'
        ? { status: { in: ['draft', 'active', 'paused'] } }
        : { status: 'active', isOpen: true, acceptingOrders: true },
      include: {
        chargeRules: {
          where: { kind: 'DELIVERY', active: true },
          orderBy: [{ deliveryType: 'asc' }, { minDistanceKm: 'asc' }, { amount: 'asc' }],
        },
      },
      orderBy: { name: 'asc' },
    })

    // Staff/admin browse all active stores. Guests/customers see pharmacies
    // that can serve their delivery place (city / distance) when known.
    const visible =
      req.user && req.user.role !== 'CUSTOMER'
        ? stores.map((store) => ({ ...store, deliveryDistanceKm: null as number | null, available: true }))
        : await filterStoresAvailableToCustomer(stores, {
            customerId: req.user?.id,
            addressId,
            latitude: Number.isFinite(latitude) ? latitude : null,
            longitude: Number.isFinite(longitude) ? longitude : null,
          })

    res.json({
      stores: visible.map((store) => ({
        id: store.id,
        code: store.code,
        name: store.name,
        address: store.address,
        city: resolveStoreCity(store),
        country: store.country || '',
        maxDeliveryDistanceKm: store.maxDeliveryDistanceKm ?? DEFAULT_MAX_DELIVERY_DISTANCE_KM,
        openUntil: store.openUntil,
        rating: store.rating,
        phone: store.phone,
        pharmacist: store.pharmacist,
        mapLat: store.mapLat,
        mapLng: store.mapLng,
        deliveryDistanceKm: store.deliveryDistanceKm,
        available: store.available,
        orderEligible: getStoreOrderEligibility(stores.find((candidate) => candidate.id === store.id)!).eligible,
        orderEligibilityReason: getStoreOrderEligibility(stores.find((candidate) => candidate.id === store.id)!).reason,
        deliveryRules: store.chargeRules.map((rule) => ({
          id: rule.id,
          label: rule.label,
          mode: rule.mode,
          amount: money(rule.amount as never),
          deliveryType: rule.deliveryType,
          minDistanceKm: rule.minDistanceKm,
          maxDistanceKm: rule.maxDistanceKm,
          perKmRate: rule.perKmRate != null ? money(rule.perKmRate as never) : null,
        })),
      })),
    })
  } catch (error) {
    next(error)
  }
})

catalogRouter.get('/categories', async (req, res, next) => {
  try {
    const storeId = String(req.query.storeId ?? '').trim()

    const products = await prisma.product.findMany({
      where: {
        held: false,
        onlineSale: true,
        published: true,
        ...(storeId ? { storeId } : {}),
      },
      select: {
        id: true,
        category: true,
        expiry: true,
      },
      orderBy: { category: 'asc' },
    })

    const categories = new Set<string>()

    for (const product of products) {
      if (!product.category.trim()) continue

      const stock = await sellableStock(product.id)

      if (stock > 0 || !isExpired(product.expiry)) {
        categories.add(product.category)
      }
    }

    res.json({
      categories: [...categories].sort((a, b) => a.localeCompare(b)),
    })
  } catch (error) {
    next(error)
  }
})

catalogRouter.get('/strengths', async (req, res, next) => {
  try {
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

    res.json({
      strengths: rows.map((row) => row.strength).filter(Boolean),
    })
  } catch (error) {
    next(error)
  }
})

catalogRouter.get('/suggest', async (req, res, next) => {
  try {
    const q = String(req.query.q ?? '').trim()

    if (q.length < 1) {
      return res.json({ suggestions: [] })
    }

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
      select: {
        name: true,
        brand: true,
        genericName: true,
      },
      orderBy: { name: 'asc' },
      take: 100,
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
  } catch (error) {
    next(error)
  }
})

catalogRouter.get('/products', async (req, res, next) => {
  try {
    const q = String(req.query.q ?? '').trim()
    const storeId = String(req.query.storeId ?? '').trim()
    const category = String(req.query.category ?? '').trim()
    const strength = String(req.query.strength ?? '').trim()
    const inStockRaw = String(req.query.inStock ?? '').trim().toLowerCase()

    const setting = await prisma.setting.findUnique({
      where: { id: 'default' },
    })

    const showOutOfStock = setting?.showOutOfStock ?? true

    const products = await prisma.product.findMany({
      where: {
        held: false,
        onlineSale: true,
        published: true,
        ...(storeId ? { storeId } : {}),
        ...(category ? { category } : {}),
        ...(strength
          ? { strength: { equals: strength, mode: 'insensitive' } }
          : {}),
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
    })

    const mapped = await Promise.all(
      products.map(async (product) => {
        const availableStock = await sellableStock(product.id)

        const mappedProduct = mapCatalogProduct({
          ...product,
          stock: availableStock,
        })

        return {
          ...mappedProduct,
          stock: availableStock,
          inStock: availableStock > 0,
          outOfStock: availableStock <= 0,
        }
      }),
    )

    const filtered = mapped.filter((product) => {
      if (inStockRaw === 'true') return product.inStock
      if (inStockRaw === 'false') return !product.inStock
      if (!showOutOfStock) return product.inStock
      return true
    })

    res.json({ products: filtered })
  } catch (error) {
    next(error)
  }
})

catalogRouter.get('/products/:id', async (req, res, next) => {
  try {
    const product = await prisma.product.findUnique({
      where: { id: req.params.id },
      include: { store: true },
    })

    if (
      !product ||
      product.held ||
      !product.onlineSale ||
      !product.published
    ) {
      throw new HttpError(404, 'Product not found')
    }

    const availableStock = await sellableStock(product.id)

    const mappedProduct = mapCatalogProduct({
      ...product,
      stock: availableStock,
    })

    res.json({
      product: {
        ...mappedProduct,
        stock: availableStock,
        inStock: availableStock > 0,
        outOfStock: availableStock <= 0,
      },
    })
  } catch (error) {
    next(error)
  }
})

catalogRouter.get('/products/:id/availability', async (req, res, next) => {
  try {
    const product = await prisma.product.findUnique({
      where: { id: req.params.id },
    })

    if (!product) {
      throw new HttpError(404, 'Product not found')
    }

    const rows = await prisma.product.findMany({
      where: {
        sku: product.sku,
        held: false,
        onlineSale: true,
        published: true,
        store: {
          isOpen: true,
          status: 'active',
          acceptingOrders: true,
        },
      },
      include: { store: true },
      orderBy: { price: 'asc' },
    })

    const stores = await Promise.all(
      rows.map(async (row) => {
        const stock = await sellableStock(row.id)

        return {
          productId: row.id,
          storeId: row.storeId,
          storeName: row.store.name,
          address: row.store.address,
          openUntil: row.store.openUntil,
          price: money(row.price),
          stock,
          inStock: stock > 0,
          expired: stock <= 0 && isExpired(row.expiry),
          expiry: row.expiry,
          batch: row.batch,
        }
      }),
    )

    res.json({
      sku: product.sku,
      stores,
    })
  } catch (error) {
    next(error)
  }
})

catalogRouter.post(
  '/products/:id/notify',
  requireAuth,
  requireRole('CUSTOMER', 'ADMIN', 'STAFF'),
  async (req, res, next) => {

  try {
    const product = await prisma.product.findUnique({
      where: { id: req.params.id },
      include: { store: true },
    })

    if (!product) {
      throw new HttpError(404, 'Product not found')
    }

    if (product.held || !product.onlineSale || !product.published) {
      throw new HttpError(400, 'This product is not available for online sale')
    }

    if (isSellable(product)) {
      const stock = await sellableStock(product.id)

      if (stock > 0) {
        throw new HttpError(400, 'This product is already in stock')
      }
    }

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
},
)

catalogRouter.delete(
  '/products/:id/notify',
  requireAuth,
  requireRole('CUSTOMER', 'ADMIN', 'STAFF'),
  async (req, res, next) => {
  try {
    const product = await prisma.product.findUnique({
      where: { id: req.params.id },
    })

    if (!product) {
      throw new HttpError(404, 'Product not found')
    }

    await prisma.stockAlert.updateMany({
      where: {
        customerId: req.user!.id,
        storeId: product.storeId,
        sku: product.sku,
        active: true,
      },
      data: { active: false },
    })

    res.json({ ok: true })
  } catch (error) {
    next(error)
  }
},
)
