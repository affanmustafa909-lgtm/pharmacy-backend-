import { Router } from 'express'
import fs from 'node:fs'
import path from 'node:path'
import multer from 'multer'
import { z } from 'zod'
import type { ChargeKind, PercentBase, Prisma } from '@prisma/client'
import { assertChargeRule } from '../domain/charges.js'
import { isExpired, isValidExpiry, normalizeExpiry } from '../lib/expiry.js'
import { HttpError, pageParams } from '../lib/http.js'
import { prisma } from '../lib/prisma.js'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { dec, money } from '../services/money.js'
import { normalizeMobileConfig } from '../services/mobileConfig.js'
import { notifyCustomer } from '../services/notifications.js'
import { assertStatusTransition } from '../services/orderStatus.js'
import {
  accessibleStoreIds,
  assertStoreAccess,
  canManageOrders,
  canReviewPrescriptions,
  writeAudit,
} from '../services/permissions.js'
import { recordStockMovement } from '../services/inventory.js'
import { buildSnapshot } from '../services/snapshot.js'

const uploadDir = path.resolve('uploads/products')
fs.mkdirSync(uploadDir, { recursive: true })
const imageUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase() || '.jpg'
      cb(null, `${req.params.id}${ext}`)
    },
  }),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) return cb(new HttpError(400, 'Choose an image file'))
    return cb(null, true)
  },
})

const productInput = z.object({
  storeId: z.string().min(1),
  name: z.string().trim().min(1).max(120),
  brand: z.string().trim().max(80).optional(),
  genericName: z.string().trim().max(120).optional(),
  strength: z.string().trim().max(40).optional(),
  category: z.string().trim().max(80).optional(),
  price: z.number().min(0),
  unitLabel: z.string().trim().max(80).optional(),
  stock: z.number().int().min(0),
  rxRequired: z.boolean().optional(),
  sku: z.string().trim().max(40).optional(),
  description: z.string().max(500).optional(),
  batch: z.string().max(40).optional(),
  expiry: z.string().max(20).optional(),
  onlineSale: z.boolean().optional(),
  held: z.boolean().optional(),
  lowStockAlerts: z.boolean().optional(),
  imageUrl: z.string().max(500).optional(),
})

const chargeInput = z.object({
  storeId: z.string().min(1),
  serviceId: z.string().nullable().optional(),
  kind: z.enum(['DELIVERY', 'SERVICE', 'BFP']),
  label: z.string().trim().min(1).max(80),
  mode: z.enum(['FIXED', 'PERCENT']),
  amount: z.number().min(0),
  percentBase: z.enum(['PRODUCT_SUBTOTAL', 'DELIVERY', 'SERVICE', 'PRODUCT_AND_DELIVERY', 'SUBTOTAL_BEFORE_BFP']).nullable().optional(),
  deliveryType: z.enum(['standard', 'express', 'pickup']).nullable().optional(),
  active: z.boolean().optional(),
})

function rejectExpiredBatch(name: string, expiry?: string | null) {
  if (expiry && isExpired(expiry)) {
    throw new HttpError(400, `${name || 'This batch'} is expired and cannot be sold`, 'EXPIRED')
  }
}

/**
 * Checks that an expiry the admin typed can be read, and returns it as YYYY-MM-DD.
 * An unreadable value (e.g. "abc" or "13/99") is refused, because it would never count as expired.
 */
function cleanExpiry(name: string, expiry?: string | null): string | undefined {
  const raw = String(expiry ?? '').trim()
  if (!raw) return undefined
  if (!isValidExpiry(raw)) {
    throw new HttpError(400, `${name || 'This medicine'} has an invalid expiry date "${raw}". Use YYYY-MM-DD or MM/YY.`, 'INVALID_EXPIRY')
  }
  return normalizeExpiry(raw) ?? raw
}

function zodFail(error: unknown) {
  return error instanceof z.ZodError ? new HttpError(400, 'Check the form and try again') : error
}

export const adminRouter = Router()
adminRouter.use(requireAuth, requireRole('ADMIN', 'STAFF'))

adminRouter.get('/snapshot', async (req, res) => {
  res.json(await buildSnapshot(req.user!))
})

adminRouter.get('/products', async (req, res, next) => {
  try {
  const { page, pageSize, skip } = pageParams(req.query as Record<string, unknown>)
  const q = String(req.query.q ?? '').trim()
  const storeId = String(req.query.storeId ?? '')
  if (storeId) await assertStoreAccess(req.user!, storeId)
  const allowed = await accessibleStoreIds(req.user!)
  const where: Prisma.ProductWhereInput = {
    ...(allowed ? { storeId: { in: allowed.length ? allowed : ['__none__'] } } : {}),
    ...(storeId ? { storeId } : {}),
    ...(q
      ? { OR: [{ name: { contains: q, mode: 'insensitive' } }, { sku: { contains: q, mode: 'insensitive' } }] }
      : {}),
  }
  const [total, items] = await Promise.all([
    prisma.product.count({ where }),
    prisma.product.findMany({ where, include: { store: true }, orderBy: { name: 'asc' }, skip, take: pageSize }),
  ])
  res.json({
    page,
    pageSize,
    total,
    pages: Math.max(1, Math.ceil(total / pageSize)),
    items: items.map((product) => ({
      id: product.id,
      storeId: product.storeId,
      storeName: product.store.name,
      name: product.name,
      brand: product.brand,
      genericName: product.genericName,
      strength: product.strength,
      category: product.category,
      price: money(product.price),
      unitLabel: product.unitLabel,
      sku: product.sku,
      stock: product.stock,
      batch: product.batch,
      expiry: product.expiry,
      expired: isExpired(product.expiry),
      held: product.held,
      onlineSale: product.onlineSale,
      published: product.published,
      outOfStock: product.stock <= 0,
      rxRequired: product.rxRequired,
      lowStockAlerts: product.lowStockAlerts,
      description: product.description,
      imageUrl: product.imageUrl,
    })),
  })
  } catch (error) {
    next(error)
  }
})

adminRouter.get('/categories', async (req, res, next) => {
  try {
  const allowed = await accessibleStoreIds(req.user!)
  const where: Prisma.ProductWhereInput = allowed
    ? { storeId: { in: allowed.length ? allowed : ['__none__'] } }
    : {}
  const rows = await prisma.product.findMany({ where, select: { category: true }, distinct: ['category'], orderBy: { category: 'asc' } })
  const defaults = ['Medicines', 'Vitamins', 'Supplements', 'Devices']
  const categories = [...new Set([...defaults, ...rows.map((row) => row.category).filter(Boolean)])].sort()
  res.json({ categories })
  } catch (error) {
    next(error)
  }
})

adminRouter.post('/products', async (req, res, next) => {
  try {
    const body = productInput.parse(req.body)
    await assertStoreAccess(req.user!, body.storeId)
    const expiry = cleanExpiry(body.name, body.expiry)
    rejectExpiredBatch(body.name, expiry)
    const sku =
      body.sku?.trim() ||
      `HER-${body.name.replace(/[^a-zA-Z0-9]/g, '').slice(0, 3).toUpperCase().padEnd(3, 'X')}-${Date.now().toString(36).slice(-4).toUpperCase()}`
    const created = await prisma.product.create({
      data: {
        storeId: body.storeId,
        sku,
        name: body.name,
        brand: body.brand || 'hera.',
        genericName: body.genericName || '',
        strength: body.strength || '',
        category: body.category || 'Medicines',
        price: dec(body.price),
        unitLabel: body.unitLabel || '1 unit',
        stock: body.stock,
        rxRequired: body.rxRequired ?? false,
        description: body.description ?? 'Added from the admin catalog.',
        batch: body.batch ?? 'NEW-26',
        expiry: expiry ?? '2027-12-31',
        onlineSale: body.onlineSale ?? true,
        held: body.held ?? false,
        lowStockAlerts: body.lowStockAlerts ?? true,
        imageUrl: body.imageUrl ?? '',
      },
    })
    await writeAudit({
      actorId: req.user!.id,
      storeId: body.storeId,
      action: 'product.create',
      detail: `Added ${created.name} (${created.sku})`,
      meta: { sku: created.sku, price: body.price, stock: body.stock },
    })
    res.status(201).json({ id: created.id })
  } catch (error) {
    next(zodFail(error))
  }
})

adminRouter.patch('/products/:id', async (req, res, next) => {
  try {
    const existing = await prisma.product.findUnique({ where: { id: req.params.id } })
    if (!existing) throw new HttpError(404, 'Medicine not found')
    await assertStoreAccess(req.user!, existing.storeId)
    const patch = productInput.partial().parse(req.body)
    if (patch.storeId) await assertStoreAccess(req.user!, patch.storeId)
    const priceChanged = patch.price != null && patch.price !== money(existing.price)
    const stockChanged = patch.stock != null && patch.stock !== existing.stock
    // Price needs the price permission. Stock edits need an owner or a store manager.
    if (priceChanged) await assertStoreAccess(req.user!, existing.storeId, { requirePrice: true })
    if (stockChanged) await assertStoreAccess(req.user!, existing.storeId, { roles: ['OWNER', 'STORE_MANAGER'] })
    // Only the expiry text is checked here. An already-expired medicine can still be edited
    // (price, stock, hold) and an admin may record a past date; the shop simply cannot sell it.
    const patchExpiry = patch.expiry != null ? cleanExpiry(patch.name || existing.name, patch.expiry) : undefined

    type Plain = string | number | boolean | null
    const changes: Record<string, { from: Plain; to: Plain }> = {}
    const track = (field: string, from: Plain, to: Plain | undefined) => {
      if (to !== undefined && from !== to) changes[field] = { from, to }
    }
    track('name', existing.name, patch.name)
    track('brand', existing.brand, patch.brand)
    track('category', existing.category, patch.category)
    track('unitLabel', existing.unitLabel, patch.unitLabel)
    track('sku', existing.sku, patch.sku)
    track('batch', existing.batch, patch.batch)
    track('expiry', existing.expiry, patchExpiry)
    track('rxRequired', existing.rxRequired, patch.rxRequired)
    track('onlineSale', existing.onlineSale, patch.onlineSale)
    track('held', existing.held, patch.held)
    track('lowStockAlerts', existing.lowStockAlerts, patch.lowStockAlerts)
    track('storeId', existing.storeId, patch.storeId)
    const oldPrice = money(existing.price)

    await prisma.product.update({
      where: { id: existing.id },
      data: {
        ...(patch.storeId ? { storeId: patch.storeId } : {}),
        ...(patch.name != null ? { name: patch.name } : {}),
        ...(patch.brand != null ? { brand: patch.brand } : {}),
        ...(patch.genericName != null ? { genericName: patch.genericName } : {}),
        ...(patch.strength != null ? { strength: patch.strength } : {}),
        ...(patch.category != null ? { category: patch.category } : {}),
        ...(patch.price != null ? { price: dec(patch.price) } : {}),
        ...(patch.unitLabel != null ? { unitLabel: patch.unitLabel } : {}),
        // stock is not written here. A stock edit goes through the stock history below.
        ...(patch.rxRequired != null ? { rxRequired: patch.rxRequired } : {}),
        ...(patch.sku != null ? { sku: patch.sku } : {}),
        ...(patch.description != null ? { description: patch.description } : {}),
        ...(patch.batch != null ? { batch: patch.batch } : {}),
        ...(patchExpiry ? { expiry: patchExpiry } : {}),
        ...(patch.onlineSale != null ? { onlineSale: patch.onlineSale } : {}),
        ...(patch.held != null ? { held: patch.held } : {}),
        ...(patch.lowStockAlerts != null ? { lowStockAlerts: patch.lowStockAlerts } : {}),
        ...(patch.imageUrl != null ? { imageUrl: patch.imageUrl } : {}),
      },
    })
    if (stockChanged && patch.stock != null) {
      await recordStockMovement({
        productId: existing.id,
        storeId: existing.storeId,
        quantity: patch.stock - existing.stock,
        reason: 'manual_adjustment',
        note: `Stock edited in the product form (${existing.stock} to ${patch.stock})`,
        userId: req.user!.id,
      })
      await writeAudit({
        actorId: req.user!.id,
        storeId: existing.storeId,
        action: 'stock.edit',
        detail: `${existing.name}: stock ${existing.stock} → ${patch.stock}`,
        meta: { sku: existing.sku, from: existing.stock, to: patch.stock },
      })
    }
    if (priceChanged && patch.price != null) {
      await writeAudit({
        actorId: req.user!.id,
        storeId: existing.storeId,
        action: 'product.price',
        detail: `${existing.name}: price ${oldPrice} → ${patch.price}`,
        meta: { sku: existing.sku, from: oldPrice, to: patch.price },
      })
    }
    if (Object.keys(changes).length > 0) {
      await writeAudit({
        actorId: req.user!.id,
        storeId: existing.storeId,
        action: 'product.update',
        detail: `${existing.name}: changed ${Object.keys(changes).join(', ')}`,
        meta: { sku: existing.sku, changes },
      })
    }
    res.status(204).end()
  } catch (error) {
    next(zodFail(error))
  }
})

adminRouter.post('/products/:id/deactivate', async (req, res, next) => {
  try {
    const existing = await prisma.product.findUnique({ where: { id: req.params.id } })
    if (!existing) throw new HttpError(404, 'Medicine not found')
    await assertStoreAccess(req.user!, existing.storeId)
    await prisma.product.update({
      where: { id: existing.id },
      data: { held: true, onlineSale: false },
    })
    await writeAudit({
      actorId: req.user!.id,
      storeId: existing.storeId,
      action: 'product.hold',
      detail: `${existing.name} was deactivated`,
      meta: { sku: existing.sku },
    })
    res.status(204).end()
  } catch (error) {
    next(error)
  }
})

adminRouter.delete('/products/:id', async (req, res, next) => {
  try {
    const existing = await prisma.product.findUnique({ where: { id: req.params.id } })
    if (!existing) throw new HttpError(404, 'Medicine not found')
    await assertStoreAccess(req.user!, existing.storeId)
    await writeAudit({
      actorId: req.user!.id,
      storeId: existing.storeId,
      action: 'product.delete',
      detail: `${existing.name} (${existing.sku}) was deleted`,
      meta: { sku: existing.sku, price: money(existing.price), stock: existing.stock },
    })
    await prisma.product.delete({ where: { id: existing.id } })
    res.status(204).end()
  } catch (error) {
    next(error)
  }
})

adminRouter.post('/products/:id/restock', async (req, res, next) => {
  try {
    const body = z
      .object({
        quantity: z.number().int().positive(),
        batchNumber: z.string().max(40).optional(),
        expiry: z.string().max(20).optional(),
        note: z.string().max(200).optional(),
      })
      .parse(req.body)
    const existing = await prisma.product.findUnique({ where: { id: req.params.id } })
    if (!existing) throw new HttpError(404, 'Medicine not found')
    await assertStoreAccess(req.user!, existing.storeId, { roles: ['OWNER', 'STORE_MANAGER'] })
    const newExpiry = cleanExpiry(existing.name, body.expiry)
    const expiry = newExpiry || existing.expiry
    if (isExpired(expiry)) {
      throw new HttpError(
        400,
        `${existing.name} is expired. Enter a new expiry date for the restocked batch.`,
        'EXPIRED',
      )
    }
    if (body.batchNumber || newExpiry) {
      // A product made from the admin form keeps its stock on the product row, with no batch rows.
      // Give that stock its own batch first, otherwise the new batch would replace it when stock is re-counted.
      const batchCount = await prisma.inventoryBatch.count({ where: { productId: existing.id } })
      if (batchCount === 0 && existing.stock > 0) {
        await prisma.inventoryBatch.create({
          data: {
            productId: existing.id,
            storeId: existing.storeId,
            batchNumber: existing.batch || `OPEN-${existing.sku}`,
            quantity: existing.stock,
            expiry: existing.expiry || '2030-12-31',
          },
        })
      }
      await prisma.inventoryBatch.create({
        data: {
          productId: existing.id,
          storeId: existing.storeId,
          batchNumber: body.batchNumber || existing.batch || `RS-${Date.now().toString(36).toUpperCase()}`,
          quantity: body.quantity,
          expiry: expiry || '12/30',
        },
      })
      await prisma.stockMovement.create({
        data: {
          productId: existing.id,
          storeId: existing.storeId,
          quantity: body.quantity,
          reason: 'restock',
          note: body.note || 'Manual restock',
          userId: req.user!.id,
        },
      })
      // The product row showed an expired date: a fresh batch with a valid date makes it sellable again.
      if (newExpiry && isExpired(existing.expiry)) {
        await prisma.product.update({
          where: { id: existing.id },
          data: { expiry: newExpiry, ...(body.batchNumber ? { batch: body.batchNumber } : {}) },
        })
      }
      const { syncProductStockFromBatches } = await import('../services/inventory.js')
      await syncProductStockFromBatches(existing.id)
    } else {
      await recordStockMovement({
        productId: existing.id,
        storeId: existing.storeId,
        quantity: body.quantity,
        reason: 'restock',
        note: body.note || 'Manual restock',
        userId: req.user!.id,
      })
    }
    const updated = await prisma.product.findUnique({ where: { id: existing.id } })
    if (!updated) throw new HttpError(404, 'Medicine not found')
    await writeAudit({
      actorId: req.user!.id,
      storeId: existing.storeId,
      action: 'stock.restock',
      detail: `Restocked ${existing.name} by ${body.quantity}`,
    })
    await prisma.notice.create({
      data: { title: 'Restock recorded', body: `${body.quantity} units added to ${existing.name}.`, at: 'Just now', page: 'medicines' },
    })
    if (existing.stock <= 0 && updated.stock > 0) {
      const alerts = await prisma.stockAlert.findMany({
        where: { storeId: existing.storeId, sku: existing.sku, active: true },
      })
      for (const alert of alerts) {
        await notifyCustomer({
          customerId: alert.customerId,
          type: 'stock',
          title: 'Back in stock',
          body: `${existing.name} is available again at your selected pharmacy.`,
          data: { productId: existing.id, storeId: existing.storeId, sku: existing.sku },
        })
      }
      if (alerts.length) {
        await prisma.stockAlert.updateMany({
          where: { id: { in: alerts.map((alert) => alert.id) } },
          data: { active: false },
        })
      }
    }
    res.status(204).end()
  } catch (error) {
    next(zodFail(error))
  }
})

adminRouter.post('/products/:id/image', (req, res, next) => {
  imageUpload.single('image')(req, res, async (uploadError) => {
    try {
      if (uploadError) throw uploadError
      const existing = await prisma.product.findUnique({ where: { id: req.params.id } })
      if (!existing) throw new HttpError(404, 'Medicine not found')
      await assertStoreAccess(req.user!, existing.storeId)
      if (!req.file) throw new HttpError(400, 'Choose an image file')
      const imageUrl = `/uploads/products/${req.file.filename}`
      await prisma.product.update({ where: { id: existing.id }, data: { imageUrl } })
      res.json({ imageUrl })
    } catch (error) {
      next(error)
    }
  })
})

adminRouter.get('/services', async (req, res) => {
  const storeId = String(req.query.storeId ?? '')
  if (!storeId) throw new HttpError(400, 'Choose a store')
  await assertStoreAccess(req.user!, storeId)
  const [services, rules] = await Promise.all([
    prisma.service.findMany({ where: { storeId }, orderBy: { name: 'asc' } }),
    prisma.chargeRule.findMany({ where: { storeId }, orderBy: { kind: 'asc' } }),
  ])
  res.json({
    services,
    rules: rules.map((rule) => ({ ...rule, amount: money(rule.amount) })),
  })
})

adminRouter.post('/services', async (req, res, next) => {
  try {
    const body = z.object({
      storeId: z.string().min(1),
      name: z.string().trim().min(1).max(80),
      description: z.string().max(240).optional(),
      active: z.boolean().optional(),
    }).parse(req.body)
    await assertStoreAccess(req.user!, body.storeId)
    const created = await prisma.service.create({
      data: { storeId: body.storeId, name: body.name, description: body.description ?? '', active: body.active ?? true },
    })
    res.status(201).json(created)
  } catch (error) {
    next(zodFail(error))
  }
})

adminRouter.delete('/services/:id', async (req, res, next) => {
  try {
    const existing = await prisma.service.findUnique({ where: { id: req.params.id } })
    if (!existing) throw new HttpError(404, 'Service not found')
    await assertStoreAccess(req.user!, existing.storeId)
    await prisma.service.delete({ where: { id: existing.id } })
    res.status(204).end()
  } catch (error) {
    next(error)
  }
})

adminRouter.post('/charge-rules', async (req, res, next) => {
  try {
    const body = chargeInput.parse(req.body)
    await assertStoreAccess(req.user!, body.storeId)
    assertChargeRule({
      kind: body.kind as ChargeKind,
      label: body.label,
      mode: body.mode,
      amount: body.amount,
      percentBase: (body.percentBase ?? null) as PercentBase | null,
      deliveryType: body.deliveryType ?? null,
    })
    const created = await prisma.chargeRule.create({
      data: {
        storeId: body.storeId,
        serviceId: body.serviceId ?? null,
        kind: body.kind,
        label: body.label,
        mode: body.mode,
        amount: dec(body.amount),
        percentBase: body.mode === 'PERCENT' ? body.percentBase ?? null : null,
        deliveryType: body.deliveryType ?? null,
        active: body.active ?? true,
      },
    })
    res.status(201).json({ id: created.id })
  } catch (error) {
    next(error instanceof Error && !(error instanceof HttpError) && !(error instanceof z.ZodError) ? new HttpError(400, error.message) : zodFail(error))
  }
})

adminRouter.delete('/charge-rules/:id', async (req, res, next) => {
  try {
    const existing = await prisma.chargeRule.findUnique({ where: { id: req.params.id } })
    if (!existing) throw new HttpError(404, 'Charge rule not found')
    await assertStoreAccess(req.user!, existing.storeId)
    await prisma.chargeRule.delete({ where: { id: existing.id } })
    res.status(204).end()
  } catch (error) {
    next(error)
  }
})

adminRouter.get('/riders', async (req, res, next) => {
  try {
    const storeId = String(req.query.storeId ?? '')
    if (!storeId) throw new HttpError(400, 'Choose a store')
    await assertStoreAccess(req.user!, storeId)
    const riders = await prisma.rider.findMany({
      where: { storeId },
      orderBy: [{ active: 'desc' }, { name: 'asc' }],
    })
    res.json({ riders })
  } catch (error) {
    next(error)
  }
})

adminRouter.post('/riders', async (req, res, next) => {
  try {
    const body = z
      .object({
        storeId: z.string().min(1),
        name: z.string().trim().min(1).max(80),
        phone: z.string().trim().max(40).optional(),
        vehicle: z.string().trim().max(40).optional(),
        notes: z.string().trim().max(240).optional(),
        active: z.boolean().optional(),
      })
      .parse(req.body)
    await assertStoreAccess(req.user!, body.storeId)
    const created = await prisma.rider.create({
      data: {
        storeId: body.storeId,
        name: body.name,
        phone: body.phone ?? '',
        vehicle: body.vehicle?.trim() || 'Bike',
        notes: body.notes ?? '',
        active: body.active ?? true,
      },
    })
    res.status(201).json(created)
  } catch (error) {
    next(zodFail(error))
  }
})

adminRouter.patch('/riders/:id', async (req, res, next) => {
  try {
    const existing = await prisma.rider.findUnique({ where: { id: req.params.id } })
    if (!existing) throw new HttpError(404, 'Rider not found')
    await assertStoreAccess(req.user!, existing.storeId)
    const body = z
      .object({
        name: z.string().trim().min(1).max(80).optional(),
        phone: z.string().trim().max(40).optional(),
        vehicle: z.string().trim().max(40).optional(),
        notes: z.string().trim().max(240).optional(),
        active: z.boolean().optional(),
      })
      .parse(req.body)
    const updated = await prisma.rider.update({
      where: { id: existing.id },
      data: {
        ...(body.name != null ? { name: body.name } : {}),
        ...(body.phone != null ? { phone: body.phone } : {}),
        ...(body.vehicle != null ? { vehicle: body.vehicle.trim() || 'Bike' } : {}),
        ...(body.notes != null ? { notes: body.notes } : {}),
        ...(body.active != null ? { active: body.active } : {}),
      },
    })
    res.json(updated)
  } catch (error) {
    next(zodFail(error))
  }
})

adminRouter.delete('/riders/:id', async (req, res, next) => {
  try {
    const existing = await prisma.rider.findUnique({ where: { id: req.params.id } })
    if (!existing) throw new HttpError(404, 'Rider not found')
    await assertStoreAccess(req.user!, existing.storeId)
    await prisma.rider.delete({ where: { id: existing.id } })
    res.status(204).end()
  } catch (error) {
    next(error)
  }
})

adminRouter.post('/orders/:number/status', async (req, res, next) => {
  try {
    const body = z
      .object({
        status: z.enum([
          'placed',
          'preparing',
          'ready_for_pickup',
          'collected',
          'out_for_delivery',
          'delivered',
          'cancelled',
        ]),
        cancelReason: z.string().max(300).optional(),
        refundReason: z.string().max(300).optional(),
        refundAmount: z.number().min(0).optional(),
      })
      .parse(req.body)
    const order = await prisma.order.findUnique({
      where: { number: req.params.number },
      include: { store: true, items: true },
    })
    if (!order) throw new HttpError(404, 'Order not found')
    const access = await assertStoreAccess(req.user!, order.storeId, {
      roles: ['OWNER', 'STORE_MANAGER', 'ORDER_STAFF'],
    })
    if (!canManageOrders(access.deskRole) && req.user!.role !== 'ADMIN') {
      throw new HttpError(403, 'Your role cannot update orders')
    }
    assertStatusTransition(order.deliveryType, order.status, body.status)
    if (body.status === 'cancelled' && body.refundAmount && body.refundAmount > 0) {
      await assertStoreAccess(req.user!, order.storeId, { requireRefund: true })
    }
    await prisma.order.update({
      where: { id: order.id },
      data: {
        status: body.status,
        ...(body.cancelReason != null ? { cancelReason: body.cancelReason } : {}),
        ...(body.refundReason != null ? { refundReason: body.refundReason } : {}),
        ...(body.refundAmount != null
          ? {
              refundAmount: dec(body.refundAmount),
              paymentStatus: body.refundAmount >= money(order.total) ? 'refunded' : 'partially_refunded',
            }
          : {}),
      },
    })
    await prisma.orderActivity.create({
      data: {
        orderId: order.id,
        label: `Status → ${body.status.replaceAll('_', ' ')}`,
        detail: body.cancelReason || body.refundReason || '',
        actor: req.user!.name,
      },
    })
    if (body.status === 'cancelled' && order.status !== 'cancelled') {
      for (const item of order.items) {
        if (!item.productId) continue
        await recordStockMovement({
          productId: item.productId,
          storeId: order.storeId,
          quantity: item.quantity,
          reason: 'cancellation_release',
          orderNumber: order.number,
          userId: req.user!.id,
          note: body.cancelReason || 'Order cancelled',
        })
      }
    }
    if (body.status === 'cancelled' && order.status !== 'cancelled') {
      await writeAudit({
        actorId: req.user!.id,
        storeId: order.storeId,
        action: 'order.cancel',
        detail: `${order.number} cancelled`,
        meta: { from: order.status, reason: body.cancelReason ?? '' },
      })
    }
    if (body.refundAmount && body.refundAmount > 0) {
      await writeAudit({
        actorId: req.user!.id,
        storeId: order.storeId,
        action: 'order.refund',
        detail: `Refund ${body.refundAmount} on ${order.number}`,
        meta: { order: order.number, amount: body.refundAmount, orderTotal: money(order.total), reason: body.refundReason ?? '' },
      })
    }
    const titles: Record<string, string> = {
      preparing: 'Order preparing',
      ready_for_pickup: 'Ready for pickup',
      collected: 'Order collected',
      out_for_delivery: 'Out for delivery',
      delivered: 'Order delivered',
      cancelled: 'Order cancelled',
    }
    if (titles[body.status]) {
      await notifyCustomer({
        customerId: order.customerId,
        type: 'order',
        title: titles[body.status],
        body:
          body.status === 'ready_for_pickup'
            ? `${order.number} is ready at ${order.store.name} (${order.store.address}). Open until ${order.store.openUntil}.`
            : body.status === 'cancelled'
              ? `${order.number} was cancelled.${body.cancelReason ? ` ${body.cancelReason}` : ''}`
              : `${order.number} is now ${body.status.replaceAll('_', ' ')}.`,
        data: { orderNumber: order.number, status: body.status },
      })
    }
    res.status(204).end()
  } catch (error) {
    next(zodFail(error))
  }
})

adminRouter.post('/prescriptions/:number/decision', async (req, res, next) => {
  try {
    const body = z
      .object({
        status: z.enum(['pending', 'needs_clearer_photo', 'approved', 'dispensed', 'rejected']),
        notes: z.string().max(500).optional(),
        verifiedItems: z
          .array(
            z.object({
              productId: z.string().optional(),
              name: z.string().min(1),
              strength: z.string().optional(),
              quantity: z.string().optional(),
              approvedQty: z.number().int().positive().optional(),
              packSize: z.string().optional(),
              unitLabel: z.string().optional(),
              sku: z.string().optional(),
            }),
          )
          .optional(),
      })
      .parse(req.body)
    const prescription = await prisma.prescription.findUnique({ where: { number: req.params.number } })
    if (!prescription) throw new HttpError(404, 'Prescription not found')
    const access = await assertStoreAccess(req.user!, prescription.storeId, {
      roles: ['OWNER', 'STORE_MANAGER', 'PHARMACIST'],
    })
    if (!canReviewPrescriptions(access.deskRole) && req.user!.role !== 'ADMIN') {
      throw new HttpError(403, 'Your role cannot review prescriptions')
    }
    if ((body.status === 'rejected' || body.status === 'needs_clearer_photo') && !body.notes?.trim()) {
      throw new HttpError(400, 'Add a short reason so the patient knows what to do next')
    }
    if (prescription.status === 'rejected' || prescription.status === 'dispensed') {
      throw new HttpError(400, 'This prescription is already closed')
    }
    if (body.status === 'dispensed' && prescription.status !== 'approved') {
      throw new HttpError(400, 'Approve the prescription before dispensing')
    }
    if (body.status === 'approved' && !body.verifiedItems?.length) {
      throw new HttpError(400, 'Select verified medicines from the store catalog before approving')
    }
    const reviewedAt = new Date()
    const enrichedItems = []
    for (const item of body.verifiedItems ?? []) {
      if (!item.productId && !item.sku) {
        throw new HttpError(400, 'Verified medicines must come from the store catalog')
      }
      const product = item.productId
        ? await prisma.product.findFirst({ where: { id: item.productId, storeId: prescription.storeId } })
        : await prisma.product.findFirst({
            where: { storeId: prescription.storeId, sku: item.sku },
          })
      if (!product) throw new HttpError(400, `${item.name} is not in this store catalog`)
      enrichedItems.push({
        productId: product.id,
        sku: product.sku,
        name: product.name,
        strength: product.strength || item.strength || '',
        packSize: product.unitLabel,
        unitLabel: product.unitLabel,
        quantity: item.quantity || String(item.approvedQty ?? 1),
        approvedQty: item.approvedQty ?? (Number(item.quantity) || 1),
        reviewer: req.user!.name,
        reviewedAt: reviewedAt.toISOString(),
      })
    }
    const updated = await prisma.prescription.update({
      where: { id: prescription.id },
      data: {
        status: body.status,
        ...(body.notes != null ? { notes: body.notes } : {}),
        ...(enrichedItems.length ? { verifiedItems: enrichedItems, medicineName: enrichedItems.map((item) => item.name).join(', ') } : {}),
        reviewerId: req.user!.id,
        reviewedAt,
        imageReadable: body.status === 'needs_clearer_photo' ? false : prescription.imageReadable,
      },
    })
    await writeAudit({
      actorId: req.user!.id,
      storeId: prescription.storeId,
      action: 'prescription.review',
      detail: `${updated.number}: ${prescription.status} → ${body.status}`,
      meta: {
        from: prescription.status,
        to: body.status,
        verifiedCount: enrichedItems.length,
        items: enrichedItems.map((item) => ({ sku: item.sku, qty: item.approvedQty })),
      },
    })
    const titles: Record<string, string> = {
      needs_clearer_photo: 'Clearer photo needed',
      approved: 'Prescription verified',
      rejected: 'Prescription rejected',
      dispensed: 'Prescription dispensed',
      pending: 'Prescription pending review',
    }
    await notifyCustomer({
      customerId: prescription.customerId,
      type: 'prescription',
      title: titles[body.status] || 'Prescription update',
      body: body.notes?.trim() || `${updated.number} is now ${body.status.replaceAll('_', ' ')}.`,
      data: {
        prescriptionNumber: updated.number,
        status: updated.status,
        verifiedItems: enrichedItems,
      },
    })
    res.status(204).end()
  } catch (error) {
    next(zodFail(error))
  }
})

adminRouter.post('/pharmacies', async (req, res, next) => {
  try {
    if (req.user!.role !== 'ADMIN') throw new HttpError(403, 'Only the main Hera admin can add stores')
    const body = z
      .object({
        code: z
          .string()
          .trim()
          .min(2)
          .max(12)
          .regex(/^[A-Za-z0-9_-]+$/, 'Store code must be letters, numbers, - or _'),
        name: z.string().trim().min(1).max(120),
        address: z.string().trim().min(5).max(240),
        openUntil: z.string().trim().min(1).max(40).default('9:00 PM'),
        phone: z.union([z.literal(''), z.string().trim().regex(/^[+()\d\s-]{7,40}$/, 'Enter a valid phone number')]).optional(),
        pharmacist: z.string().trim().max(80).optional(),
        pharmacistUserId: z.string().optional(),
        managerUserId: z.string().optional(),
        status: z.enum(['draft', 'active']).optional(),
        isOpen: z.boolean().optional(),
        acceptingOrders: z.boolean().optional(),
        weeklyHours: z.record(z.any()).optional(),
        mapLat: z.number().optional(),
        mapLng: z.number().optional(),
        standardDelivery: z.number().min(0).optional(),
        expressDelivery: z.number().min(0).optional(),
      })
      .parse(req.body)
    const code = body.code.toUpperCase()
    const exists = await prisma.store.findUnique({ where: { code } })
    if (exists) throw new HttpError(400, `Store code ${code} is already in use`)
    const status = body.status ?? 'draft'
    const deliveryFees = [
      { type: 'standard', label: 'Standard', fee: body.standardDelivery ?? 3.5, eta: 60 },
      { type: 'express', label: 'Express', fee: body.expressDelivery ?? 6.5, eta: 30 },
      { type: 'pickup', label: 'Pickup', fee: 0, eta: 20 },
    ]

    // Persist store + related rows in one transaction so a partial failure cannot leave a ghost or roll back silently later.
    const storeId = await prisma.$transaction(async (tx) => {
      const store = await tx.store.create({
        data: {
          code,
          name: body.name,
          address: body.address,
          openUntil: body.openUntil,
          phone: body.phone ?? '',
          pharmacist: body.pharmacist ?? '',
          pharmacistUserId: body.pharmacistUserId ?? null,
          managerUserId: body.managerUserId ?? null,
          status,
          isOpen: status === 'active' ? (body.isOpen ?? true) : false,
          acceptingOrders: status === 'active' ? (body.acceptingOrders ?? true) : false,
          weeklyHours: body.weeklyHours ?? {},
          mapLat: body.mapLat,
          mapLng: body.mapLng,
        },
      })
      await tx.storeAssignment.create({
        data: {
          userId: req.user!.id,
          storeId: store.id,
          deskRole: 'OWNER',
          canChangePrice: true,
          canRefund: true,
        },
      })
      await tx.chargeRule.createMany({
        data: deliveryFees.map((item) => ({
          storeId: store.id,
          kind: 'DELIVERY' as const,
          label: `${item.label} delivery`.replace('Pickup delivery', 'Store pickup'),
          mode: 'FIXED' as const,
          amount: dec(item.fee),
          deliveryType: item.type,
          active: true,
        })),
      })
      await tx.storeDeliveryOption.createMany({
        data: deliveryFees.map((item) => ({
          storeId: store.id,
          type: item.type,
          label: item.label,
          available: true,
          fee: dec(item.fee),
          etaMinutes: item.eta,
          deliveryArea: item.type === 'pickup' ? '' : 'Local delivery area',
        })),
      })
      await tx.auditLog.create({
        data: {
          actorId: req.user!.id,
          storeId: store.id,
          action: 'store.create',
          detail: `Created ${store.code} as ${status}`,
        },
      })
      return store.id
    })

    // Confirm the committed row before telling the client it succeeded.
    const saved = await prisma.store.findUnique({ where: { id: storeId } })
    if (!saved) throw new HttpError(500, 'Store was not saved. Try again.')

    res.status(201).json({
      id: saved.id,
      code: saved.code,
      name: saved.name,
      status: saved.status,
      createdAt: saved.createdAt.toISOString(),
    })
  } catch (error) {
    next(zodFail(error))
  }
})

adminRouter.delete('/pharmacies/:id', async (req, res, next) => {
  try {
    if (req.user!.role !== 'ADMIN') throw new HttpError(403, 'Only the main Hera admin can archive stores')
    const store = await prisma.store.findUnique({ where: { id: req.params.id } })
    if (!store) throw new HttpError(404, 'Store not found')
    await prisma.store.update({
      where: { id: store.id },
      data: { status: 'archived', isOpen: false, acceptingOrders: false },
    })
    await writeAudit({
      actorId: req.user!.id,
      storeId: store.id,
      action: 'store.archive',
      detail: `Archived ${store.code}`,
    })
    res.status(204).end()
  } catch (error) {
    next(error)
  }
})

adminRouter.post('/pharmacies/:id/open', async (req, res, next) => {
  try {
    const isOpen = z.object({ isOpen: z.boolean() }).parse(req.body).isOpen
    await assertStoreAccess(req.user!, req.params.id, { roles: ['OWNER', 'STORE_MANAGER'] })
    await prisma.store.update({ where: { id: req.params.id }, data: { isOpen } })
    res.status(204).end()
  } catch (error) {
    next(zodFail(error))
  }
})

adminRouter.patch('/pharmacies/:id', async (req, res, next) => {
  try {
    await assertStoreAccess(req.user!, req.params.id, { roles: ['OWNER', 'STORE_MANAGER'] })
    const body = z
      .object({
        name: z.string().trim().min(1).max(120).optional(),
        address: z.string().trim().min(5).max(240).optional(),
        openUntil: z.string().trim().min(1).max(40).optional(),
        phone: z.string().trim().max(40).optional(),
        pharmacist: z.string().trim().max(80).optional(),
        pharmacistUserId: z.string().nullable().optional(),
        managerUserId: z.string().nullable().optional(),
        isOpen: z.boolean().optional(),
        acceptingOrders: z.boolean().optional(),
        status: z.enum(['draft', 'active', 'paused', 'archived']).optional(),
        weeklyHours: z.record(z.any()).optional(),
        closedDays: z.array(z.string()).optional(),
        holidayHours: z.array(z.any()).optional(),
        mapLat: z.number().nullable().optional(),
        mapLng: z.number().nullable().optional(),
        lowStockThreshold: z.number().int().min(0).optional(),
      })
      .parse(req.body)
    if (body.status === 'active' || body.status === 'draft' || body.status === 'archived') {
      if (req.user!.role !== 'ADMIN') {
        const access = await assertStoreAccess(req.user!, req.params.id, { roles: ['OWNER'] })
        if (access.deskRole !== 'OWNER') throw new HttpError(403, 'Only the main owner can publish or archive stores')
      }
    }
    const updated = await prisma.store.update({
      where: { id: req.params.id },
      data: {
        ...(body.name != null ? { name: body.name } : {}),
        ...(body.address != null ? { address: body.address } : {}),
        ...(body.openUntil != null ? { openUntil: body.openUntil } : {}),
        ...(body.phone != null ? { phone: body.phone } : {}),
        ...(body.pharmacist != null ? { pharmacist: body.pharmacist } : {}),
        ...(body.pharmacistUserId !== undefined ? { pharmacistUserId: body.pharmacistUserId } : {}),
        ...(body.managerUserId !== undefined ? { managerUserId: body.managerUserId } : {}),
        ...(body.isOpen != null ? { isOpen: body.isOpen } : {}),
        ...(body.acceptingOrders != null ? { acceptingOrders: body.acceptingOrders } : {}),
        ...(body.status != null
          ? {
              status: body.status,
              ...(body.status === 'active' ? { isOpen: true, acceptingOrders: body.acceptingOrders ?? true } : {}),
              ...(body.status === 'paused' ? { acceptingOrders: false } : {}),
              ...(body.status === 'archived' ? { isOpen: false, acceptingOrders: false } : {}),
              ...(body.status === 'draft' ? { isOpen: false, acceptingOrders: false } : {}),
            }
          : {}),
        ...(body.weeklyHours != null ? { weeklyHours: body.weeklyHours } : {}),
        ...(body.closedDays != null ? { closedDays: body.closedDays } : {}),
        ...(body.holidayHours != null ? { holidayHours: body.holidayHours } : {}),
        ...(body.mapLat !== undefined ? { mapLat: body.mapLat } : {}),
        ...(body.mapLng !== undefined ? { mapLng: body.mapLng } : {}),
        ...(body.lowStockThreshold != null ? { lowStockThreshold: body.lowStockThreshold } : {}),
      },
    })
    if (body.pharmacistUserId) {
      const pharmacist = await prisma.user.findUnique({ where: { id: body.pharmacistUserId } })
      if (pharmacist) {
        await prisma.store.update({ where: { id: updated.id }, data: { pharmacist: pharmacist.name } })
      }
    }
    await writeAudit({
      actorId: req.user!.id,
      storeId: updated.id,
      action: 'store.update',
      detail: `Updated ${updated.code}`,
      meta: {
        status: body.status ?? null,
        acceptingOrders: body.acceptingOrders ?? null,
        pharmacistUserId: body.pharmacistUserId ?? null,
        managerUserId: body.managerUserId ?? null,
      },
    })
    res.status(204).end()
  } catch (error) {
    next(zodFail(error))
  }
})

adminRouter.get('/audit-log', async (req, res, next) => {
  try {
    if (req.user!.role !== 'ADMIN') throw new HttpError(403, 'Audit log is owner-only')
    const storeId = String(req.query.storeId ?? '')
    if (storeId) await assertStoreAccess(req.user!, storeId)
    // Optional filters: ?action=product (matches product.price, product.update ...), ?from=, ?to=, ?limit=
    const action = String(req.query.action ?? '').trim()
    const from = req.query.from ? new Date(String(req.query.from)) : undefined
    const to = req.query.to ? new Date(String(req.query.to)) : undefined
    if ((from && Number.isNaN(from.getTime())) || (to && Number.isNaN(to.getTime()))) {
      throw new HttpError(400, 'Date is not valid')
    }
    const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 500)
    const allowed = await accessibleStoreIds(req.user!)
    const items = await prisma.auditLog.findMany({
      where: {
        ...(storeId ? { storeId } : allowed ? { storeId: { in: allowed } } : {}),
        ...(action ? { action: { startsWith: action } } : {}),
        ...(from || to ? { createdAt: { gte: from, lte: to } } : {}),
      },
      include: { actor: true, store: true },
      orderBy: { createdAt: 'desc' },
      take: limit,
    })
    res.json({
      items: items.map((item) => ({
        id: item.id,
        action: item.action,
        detail: item.detail,
        actor: item.actor?.name ?? 'System',
        storeCode: item.store?.code ?? '',
        storeName: item.store?.name ?? '',
        createdAt: item.createdAt.toISOString(),
        meta: item.meta,
      })),
    })
  } catch (error) {
    next(error)
  }
})

adminRouter.post('/reminders/:id/toggle', async (req, res, next) => {
  try {
    const reminder = await prisma.reminder.findUnique({ where: { id: req.params.id } })
    if (!reminder) throw new HttpError(404, 'Reminder not found')
    await prisma.reminder.update({ where: { id: reminder.id }, data: { enabled: !reminder.enabled } })
    res.status(204).end()
  } catch (error) {
    next(error)
  }
})

adminRouter.post('/reminders', async (req, res, next) => {
  try {
    const body = z
      .object({
        customerName: z.string().trim().min(1).max(80),
        medicine: z.string().trim().min(1).max(120),
        time: z.string().trim().min(1).max(40),
        frequency: z.string().trim().min(1).max(40),
        enabled: z.boolean().optional(),
      })
      .parse(req.body)
    const customer = await prisma.user.findFirst({
      where: { role: 'CUSTOMER', name: { equals: body.customerName, mode: 'insensitive' } },
    })
    await prisma.reminder.create({
      data: {
        customerId: customer?.id,
        customerName: body.customerName,
        medicine: body.medicine,
        time: body.time,
        frequency: body.frequency,
        enabled: body.enabled ?? true,
      },
    })
    res.status(201).json({ ok: true })
  } catch (error) {
    next(zodFail(error))
  }
})

adminRouter.delete('/reminders/:id', async (req, res, next) => {
  try {
    const reminder = await prisma.reminder.findUnique({ where: { id: req.params.id } })
    if (!reminder) throw new HttpError(404, 'Reminder not found')
    await prisma.reminder.delete({ where: { id: reminder.id } })
    res.status(204).end()
  } catch (error) {
    next(error)
  }
})

adminRouter.get('/mobile-config', async (_req, res) => {
  const setting = await prisma.setting.findUnique({ where: { id: 'default' } })
  const promos = await prisma.promoCode.findMany({ orderBy: { code: 'asc' } })
  res.json({
    config: normalizeMobileConfig(setting?.mobileConfig),
    promos: promos.map((promo) => ({
      id: promo.id,
      code: promo.code,
      label: promo.label,
      discount: money(promo.discount),
      active: promo.active,
    })),
  })
})

adminRouter.put('/mobile-config', async (req, res, next) => {
  try {
    const config = normalizeMobileConfig(req.body?.config ?? req.body)
    await prisma.setting.update({
      where: { id: 'default' },
      data: { mobileConfig: config },
    })
    res.status(204).end()
  } catch (error) {
    next(error)
  }
})

adminRouter.post('/promos', async (req, res, next) => {
  try {
    const body = z
      .object({
        code: z.string().trim().min(2).max(40),
        label: z.string().trim().min(1).max(120),
        discount: z.number().min(0),
        active: z.boolean().optional(),
      })
      .parse(req.body)
    await prisma.promoCode.create({
      data: {
        code: body.code.toUpperCase(),
        label: body.label,
        discount: dec(body.discount),
        active: body.active ?? true,
      },
    })
    res.status(201).json({ ok: true })
  } catch (error) {
    next(zodFail(error))
  }
})

adminRouter.patch('/promos/:id', async (req, res, next) => {
  try {
    const body = z
      .object({
        label: z.string().trim().min(1).max(120).optional(),
        discount: z.number().min(0).optional(),
        active: z.boolean().optional(),
      })
      .parse(req.body)
    const promo = await prisma.promoCode.findUnique({ where: { id: req.params.id } })
    if (!promo) throw new HttpError(404, 'Promo not found')
    await prisma.promoCode.update({
      where: { id: promo.id },
      data: {
        ...(body.label != null ? { label: body.label } : {}),
        ...(body.discount != null ? { discount: dec(body.discount) } : {}),
        ...(body.active != null ? { active: body.active } : {}),
      },
    })
    res.status(204).end()
  } catch (error) {
    next(zodFail(error))
  }
})

adminRouter.delete('/promos/:id', async (req, res, next) => {
  try {
    const promo = await prisma.promoCode.findUnique({ where: { id: req.params.id } })
    if (!promo) throw new HttpError(404, 'Promo not found')
    await prisma.promoCode.delete({ where: { id: promo.id } })
    res.status(204).end()
  } catch (error) {
    next(error)
  }
})

adminRouter.post('/campaigns/:id/toggle', async (req, res, next) => {
  try {
    const campaign = await prisma.campaign.findUnique({ where: { id: req.params.id } })
    if (!campaign) throw new HttpError(404, 'Campaign not found')
    await prisma.campaign.update({ where: { id: campaign.id }, data: { active: !campaign.active } })
    res.status(204).end()
  } catch (error) {
    next(error)
  }
})

adminRouter.post('/care/redeem', async (req, res, next) => {
  try {
    const points = z.object({ points: z.number().int().positive() }).parse(req.body).points
    const setting = await prisma.setting.findUnique({ where: { id: 'default' } })
    if (!setting || points > setting.carePoints) throw new HttpError(400, 'Not enough care points')
    await prisma.setting.update({
      where: { id: 'default' },
      data: { carePoints: { decrement: points }, rewardValue: Math.max(0, setting.rewardValue - 25) },
    })
    await prisma.careEvent.create({ data: { title: 'Redeemed · refill reminder batch', dateLabel: 'Today', points: -points } })
    res.status(204).end()
  } catch (error) {
    next(zodFail(error))
  }
})

adminRouter.post('/messages/:threadId', async (req, res, next) => {
  try {
    const text = z.object({ text: z.string().trim().min(1).max(1000) }).parse(req.body).text
    const thread = await prisma.messageThread.findUnique({ where: { id: req.params.threadId } })
    if (!thread) throw new HttpError(404, 'Conversation not found')
    await prisma.message.create({
      data: {
        threadId: thread.id,
        from: 'staff',
        text,
        at: new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
      },
    })
    await prisma.messageThread.update({ where: { id: thread.id }, data: { unread: 0 } })
    res.status(204).end()
  } catch (error) {
    next(zodFail(error))
  }
})

adminRouter.post('/notices/read', async (_req, res) => {
  await prisma.notice.updateMany({ data: { read: true } })
  res.status(204).end()
})

adminRouter.post('/settings', async (req, res, next) => {
  try {
    const patch = z.object({
      storeName: z.string().trim().min(1).max(80).optional(),
      alertEmail: z.boolean().optional(),
      lowStockThreshold: z.number().int().min(0).optional(),
      autoApproveRefills: z.boolean().optional(),
      showOutOfStock: z.boolean().optional(),
    }).parse(req.body)
    await prisma.setting.update({ where: { id: 'default' }, data: patch })
    res.status(204).end()
  } catch (error) {
    next(zodFail(error))
  }
})

adminRouter.post('/payouts', async (req, res, next) => {
  try {
    if (req.user!.role !== 'ADMIN') throw new HttpError(403, 'Only a pharmacy lead can record a payout')
    const body = z.object({ amount: z.number().positive(), note: z.string().max(160).optional() }).parse(req.body)
    await prisma.payout.create({ data: { amount: dec(body.amount), note: body.note?.trim() || 'Manual payout' } })
    await prisma.notice.create({
      data: { title: 'Payout recorded', body: body.note?.trim() || `$${body.amount.toFixed(2)} marked for settlement.`, at: 'Just now', page: 'reports' },
    })
    res.status(204).end()
  } catch (error) {
    next(zodFail(error))
  }
})