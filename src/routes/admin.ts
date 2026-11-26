
import { Router } from 'express'
import fs from 'node:fs'
import path from 'node:path'
import multer from 'multer'
import { z } from 'zod'
import type { ChargeKind, PercentBase, Prisma } from '@prisma/client'
import { assertChargeRule } from '../domain/charges.js'
import { isExpired } from '../lib/expiry.js'
import { HttpError, pageParams } from '../lib/http.js'
import { prisma } from '../lib/prisma.js'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { dec, money } from '../services/money.js'
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
    if (!file.mimetype.startsWith('image/')) {
      return cb(new HttpError(400, 'Choose an image file'))
    }
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
  published: z.boolean().optional(),
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
  percentBase: z.enum([
    'PRODUCT_SUBTOTAL',
    'DELIVERY',
    'SERVICE',
    'PRODUCT_AND_DELIVERY',
    'SUBTOTAL_BEFORE_BFP',
  ]).nullable().optional(),
  deliveryType: z.enum(['standard', 'express', 'pickup']).nullable().optional(),
  minDistanceKm: z.number().min(0).nullable().optional(),
  maxDistanceKm: z.number().positive().nullable().optional(),
  perKmRate: z.number().min(0).nullable().optional(),
  active: z.boolean().optional(),
})

function rejectExpiredBatch(name: string, expiry?: string | null) {
  if (expiry && isExpired(expiry)) {
    throw new HttpError(
      400,
      `${name || 'This batch'} is expired and cannot be sold`,
      'EXPIRED',
    )
  }
}

function zodFail(error: unknown) {
  return error instanceof z.ZodError
    ? new HttpError(400, 'Check the form and try again')
    : error
}

export const adminRouter = Router()
adminRouter.use(requireAuth, requireRole('ADMIN', 'STAFF'))

adminRouter.get('/snapshot', async (req, res) => {
  res.set('Cache-Control', 'no-store')
  res.json(await buildSnapshot(req.user!))
})

adminRouter.get('/products', async (req, res, next) => {
  try {
    const { page, pageSize, skip } = pageParams(
      req.query as Record<string, unknown>,
    )
  const q = String(req.query.q ?? '').trim()
  const storeId = String(req.query.storeId ?? '')

    if (storeId) await assertStoreAccess(req.user!, storeId)

    const allowed = await accessibleStoreIds(req.user!)

  const where: Prisma.ProductWhereInput = {
      ...(allowed
        ? { storeId: { in: allowed.length ? allowed : ['__none__'] } }
        : {}),
    ...(storeId ? { storeId } : {}),
    ...(q
        ? {
            OR: [
              { name: { contains: q, mode: 'insensitive' } },
              { sku: { contains: q, mode: 'insensitive' } },
            ],
          }
      : {}),
  }

  const [total, items] = await Promise.all([
    prisma.product.count({ where }),
      prisma.product.findMany({
        where,
        include: { store: true },
        orderBy: { name: 'asc' },
        skip,
        take: pageSize,
      }),
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

    const rows = await prisma.product.findMany({
      where,
      select: { category: true },
      distinct: ['category'],
      orderBy: { category: 'asc' },
    })

  const defaults = ['Medicines', 'Vitamins', 'Supplements', 'Devices']

    const categories = [
      ...new Set([
        ...defaults,
        ...rows.map((row) => row.category).filter(Boolean),
      ]),
    ].sort()

  res.json({ categories })
  } catch (error) {
    next(error)
  }
})

adminRouter.post('/products', async (req, res, next) => {
  try {
    const body = productInput.parse(req.body)

    await assertStoreAccess(req.user!, body.storeId)
    rejectExpiredBatch(body.name, body.expiry)

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
        expiry: body.expiry ?? '12/27',
        onlineSale: body.onlineSale ?? true,
        held: body.held ?? false,
        published: body.published ?? true,
        lowStockAlerts: body.lowStockAlerts ?? true,
        imageUrl: body.imageUrl ?? '',
      },
    })

    res.status(201).json({ id: created.id })
  } catch (error) {
    next(zodFail(error))
  }
})

adminRouter.patch('/products/:id', async (req, res, next) => {
  try {
    const existing = await prisma.product.findUnique({
      where: { id: req.params.id },
    })

    if (!existing) throw new HttpError(404, 'Medicine not found')

    await assertStoreAccess(req.user!, existing.storeId)

    const patch = productInput.partial().parse(req.body)

    if (patch.storeId) {
      await assertStoreAccess(req.user!, patch.storeId)
    }

    rejectExpiredBatch(
      patch.name || existing.name,
      patch.expiry ?? existing.expiry,
    )

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
        ...(patch.stock != null ? { stock: patch.stock } : {}),
        ...(patch.rxRequired != null ? { rxRequired: patch.rxRequired } : {}),
        ...(patch.sku != null ? { sku: patch.sku } : {}),
        ...(patch.description != null ? { description: patch.description } : {}),
        ...(patch.batch != null ? { batch: patch.batch } : {}),
        ...(patch.expiry != null ? { expiry: patch.expiry } : {}),
        ...(patch.onlineSale != null ? { onlineSale: patch.onlineSale } : {}),
        ...(patch.held != null ? { held: patch.held } : {}),
        ...(patch.published != null ? { published: patch.published } : {}),
        ...(patch.lowStockAlerts != null
          ? { lowStockAlerts: patch.lowStockAlerts }
          : {}),
        ...(patch.imageUrl != null ? { imageUrl: patch.imageUrl } : {}),
      },
    })

    res.status(204).end()
  } catch (error) {
    next(zodFail(error))
  }
})

adminRouter.post('/products/:id/deactivate', async (req, res, next) => {
  try {
    const existing = await prisma.product.findUnique({
      where: { id: req.params.id },
    })

    if (!existing) throw new HttpError(404, 'Medicine not found')

    await assertStoreAccess(req.user!, existing.storeId)

    await prisma.product.update({
      where: { id: existing.id },
      data: { held: true, onlineSale: false },
    })

    res.status(204).end()
  } catch (error) {
    next(error)
  }
})

adminRouter.delete('/products/:id', async (req, res, next) => {
  try {
    const existing = await prisma.product.findUnique({
      where: { id: req.params.id },
    })

    if (!existing) throw new HttpError(404, 'Medicine not found')

    await assertStoreAccess(req.user!, existing.storeId)

    await prisma.product.delete({ where: { id: existing.id } })

    res.status(204).end()
  } catch (error) {
    next(error)
  }
})

adminRouter.post('/products/:id/restock', async (req, res, next) => {
  try {
    const body = z.object({
      quantity: z.number().int().positive(),
      batchNumber: z.string().max(40).optional(),
      expiry: z.string().max(20).optional(),
      note: z.string().max(200).optional(),
    }).parse(req.body)

    const existing = await prisma.product.findUnique({
      where: { id: req.params.id },
    })

    if (!existing) throw new HttpError(404, 'Medicine not found')

    await assertStoreAccess(req.user!, existing.storeId, {
      roles: ['OWNER', 'STORE_MANAGER'],
    })

    const expiry = body.expiry || existing.expiry
    rejectExpiredBatch(existing.name, expiry)

    if (body.batchNumber || body.expiry) {
      await prisma.$transaction(async (tx) => {
        await tx.inventoryBatch.create({
          data: {
            productId: existing.id,
            storeId: existing.storeId,
            batchNumber:
              body.batchNumber ||
              existing.batch ||
              `RS-${Date.now().toString(36).toUpperCase()}`,
            quantity: body.quantity,
            expiry: expiry || '12/30',
          },
        })

        await tx.stockMovement.create({
          data: {
            productId: existing.id,
            storeId: existing.storeId,
            quantity: body.quantity,
            reason: 'restock',
            note: body.note || 'Manual restock',
            userId: req.user!.id,
          },
        })
      })

      const { syncProductStockFromBatches } = await import(
        '../services/inventory.js'
      )

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

    const updated = await prisma.product.findUnique({
      where: { id: existing.id },
    })

    if (!updated) throw new HttpError(404, 'Medicine not found')

    await writeAudit({
      actorId: req.user!.id,
      storeId: existing.storeId,
      action: 'stock.restock',
      detail: `Restocked ${existing.name} by ${body.quantity}`,
    })

    await prisma.notice.create({
      data: {
        title: 'Restock recorded',
        body: `${body.quantity} units added to ${existing.name}.`,
        at: 'Just now',
        page: 'medicines',
      },
    })

    if (existing.stock <= 0 && updated.stock > 0) {
      const alerts = await prisma.stockAlert.findMany({
        where: {
          storeId: existing.storeId,
          sku: existing.sku,
          active: true,
        },
      })

      for (const alert of alerts) {
        await notifyCustomer({
          customerId: alert.customerId,
          type: 'stock',
          title: 'Back in stock',
          body: `${existing.name} is available again at your selected pharmacy.`,
          data: {
            productId: existing.id,
            storeId: existing.storeId,
            sku: existing.sku,
          },
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

      const existing = await prisma.product.findUnique({
        where: { id: req.params.id },
      })

      if (!existing) throw new HttpError(404, 'Medicine not found')

      await assertStoreAccess(req.user!, existing.storeId)

      if (!req.file) throw new HttpError(400, 'Choose an image file')

      const imageUrl = `/uploads/products/${req.file.filename}`

      await prisma.product.update({
        where: { id: existing.id },
        data: { imageUrl },
      })

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
    prisma.service.findMany({
      where: { storeId },
      orderBy: { name: 'asc' },
    }),
    prisma.chargeRule.findMany({
      where: { storeId },
      orderBy: { kind: 'asc' },
    }),
  ])

  res.json({
    services,
    rules: rules.map((rule) => ({
      ...rule,
      amount: money(rule.amount),
      perKmRate: rule.perKmRate != null ? money(rule.perKmRate) : null,
    })),
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
      data: {
        storeId: body.storeId,
        name: body.name,
        description: body.description ?? '',
        active: body.active ?? true,
      },
    })

    res.status(201).json(created)
  } catch (error) {
    next(zodFail(error))
  }
})

adminRouter.delete('/services/:id', async (req, res, next) => {
  try {
    const existing = await prisma.service.findUnique({
      where: { id: req.params.id },
    })

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
      minDistanceKm: body.kind === 'DELIVERY' ? (body.minDistanceKm ?? null) : null,
      maxDistanceKm: body.kind === 'DELIVERY' ? (body.maxDistanceKm ?? null) : null,
      perKmRate: body.kind === 'DELIVERY' ? (body.perKmRate ?? null) : null,
    })

    const created = await prisma.chargeRule.create({
      data: {
        storeId: body.storeId,
        serviceId: body.serviceId ?? null,
        kind: body.kind,
        label: body.label,
        mode: body.mode,
        amount: dec(body.amount),
        percentBase: body.mode === 'PERCENT'
          ? body.percentBase ?? null
          : null,
        deliveryType: body.deliveryType ?? null,
        minDistanceKm: body.kind === 'DELIVERY' ? (body.minDistanceKm ?? null) : null,
        maxDistanceKm: body.kind === 'DELIVERY' ? (body.maxDistanceKm ?? null) : null,
        perKmRate:
          body.kind === 'DELIVERY' && body.perKmRate != null
            ? dec(body.perKmRate)
            : null,
        active: body.active ?? true,
      },
    })

    res.status(201).json({ id: created.id })
  } catch (error) {
    next(
      error instanceof Error &&
      !(error instanceof HttpError) &&
      !(error instanceof z.ZodError)
        ? new HttpError(400, error.message)
        : zodFail(error),
    )
  }
})

adminRouter.patch('/charge-rules/:id', async (req, res, next) => {
  try {
    const body = chargeInput.omit({ storeId: true }).partial().parse(req.body)
    const existing = await prisma.chargeRule.findUnique({
      where: { id: req.params.id },
    })

    if (!existing) throw new HttpError(404, 'Charge rule not found')

    await assertStoreAccess(req.user!, existing.storeId)

    const nextKind = (body.kind ?? existing.kind) as ChargeKind
    const nextLabel = body.label ?? existing.label
    const nextMode = body.mode ?? existing.mode
    const nextAmount = body.amount ?? money(existing.amount)
    const nextPercentBase =
      nextMode === 'PERCENT'
        ? ((body.percentBase !== undefined ? body.percentBase : existing.percentBase) as PercentBase | null)
        : null
    const nextDeliveryType =
      body.deliveryType !== undefined ? body.deliveryType : existing.deliveryType
    const nextMinDistanceKm =
      nextKind === 'DELIVERY'
        ? (body.minDistanceKm !== undefined ? body.minDistanceKm : existing.minDistanceKm)
        : null
    const nextMaxDistanceKm =
      nextKind === 'DELIVERY'
        ? (body.maxDistanceKm !== undefined ? body.maxDistanceKm : existing.maxDistanceKm)
        : null
    const nextPerKmRate =
      nextKind === 'DELIVERY'
        ? (body.perKmRate !== undefined
            ? body.perKmRate
            : existing.perKmRate != null
              ? money(existing.perKmRate)
              : null)
        : null

    assertChargeRule({
      kind: nextKind,
      label: nextLabel,
      mode: nextMode,
      amount: nextAmount,
      percentBase: nextPercentBase,
      deliveryType: nextDeliveryType,
      minDistanceKm: nextMinDistanceKm,
      maxDistanceKm: nextMaxDistanceKm,
      perKmRate: nextPerKmRate,
    })

    const updated = await prisma.chargeRule.update({
      where: { id: existing.id },
      data: {
        kind: nextKind,
        label: nextLabel,
        mode: nextMode,
        amount: dec(nextAmount),
        percentBase: nextPercentBase,
        deliveryType: nextDeliveryType,
        minDistanceKm: nextMinDistanceKm,
        maxDistanceKm: nextMaxDistanceKm,
        perKmRate: nextPerKmRate != null ? dec(nextPerKmRate) : null,
        active: body.active ?? existing.active,
      },
    })

    res.json({
      ...updated,
      amount: money(updated.amount),
      perKmRate: updated.perKmRate != null ? money(updated.perKmRate) : null,
    })
  } catch (error) {
    next(
      error instanceof Error &&
      !(error instanceof HttpError) &&
      !(error instanceof z.ZodError)
        ? new HttpError(400, error.message)
        : zodFail(error),
    )
  }
})

adminRouter.delete('/charge-rules/:id', async (req, res, next) => {
  try {
    const existing = await prisma.chargeRule.findUnique({
      where: { id: req.params.id },
    })

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
    const pendingOnly = String(req.query.pending ?? '') === '1'

    if (pendingOnly) {
      const riders = await prisma.rider.findMany({
        where: { approvalStatus: 'pending' },
        include: {
          store: { select: { id: true, name: true } },
          user: { select: { id: true, email: true, phone: true } },
        },
        orderBy: { createdAt: 'desc' },
      })
      res.json({
        riders: riders.map((rider) => ({
          ...rider,
          email: rider.user?.email ?? '',
          preferredStoreName: rider.store?.name ?? null,
        })),
      })
      return
    }

    if (!storeId) throw new HttpError(400, 'Choose a store')

    await assertStoreAccess(req.user!, storeId)

    const riders = await prisma.rider.findMany({
      where: { storeId },
      include: { user: { select: { email: true } } },
      orderBy: [{ active: 'desc' }, { name: 'asc' }],
    })

    res.json({
      riders: riders.map((rider) => ({
        ...rider,
        email: rider.user?.email ?? '',
      })),
    })
  } catch (error) {
    next(error)
  }
})

adminRouter.post('/riders/:id/approve', async (req, res, next) => {
  try {
    const body = z
      .object({
        storeId: z.string().min(1),
        isPrimary: z.boolean().optional(),
      })
      .parse(req.body)

    await assertStoreAccess(req.user!, body.storeId)

    const existing = await prisma.rider.findUnique({ where: { id: req.params.id } })
    if (!existing) throw new HttpError(404, 'Rider application not found')

    if (body.isPrimary) {
      await prisma.rider.updateMany({
        where: { storeId: body.storeId, isPrimary: true },
        data: { isPrimary: false },
      })
    }

    const updated = await prisma.rider.update({
      where: { id: existing.id },
      data: {
        storeId: body.storeId,
        approvalStatus: 'approved',
        active: true,
        isPrimary: body.isPrimary ?? existing.isPrimary,
        rejectedReason: '',
        reviewedAt: new Date(),
      },
      include: { user: { select: { id: true, email: true } } },
    })

    if (updated.userId) {
      await prisma.user.update({
        where: { id: updated.userId },
        data: { storeId: body.storeId },
      })
    }

    await prisma.notice.create({
      data: {
        title: 'Rider approved',
        body: `${updated.name} can now sign in and take orders for the assigned pharmacy.`,
        at: 'Just now',
        page: 'pharmacies',
      },
    }).catch(() => undefined)

    res.json(updated)
  } catch (error) {
    next(zodFail(error))
  }
})

adminRouter.post('/riders/:id/reject', async (req, res, next) => {
  try {
    const body = z
      .object({
        reason: z.string().trim().max(300).optional(),
      })
      .parse(req.body)

    const existing = await prisma.rider.findUnique({ where: { id: req.params.id } })
    if (!existing) throw new HttpError(404, 'Rider application not found')

    if (existing.storeId) {
      await assertStoreAccess(req.user!, existing.storeId)
    } else if (req.user!.role !== 'ADMIN') {
      throw new HttpError(403, 'Only an admin can reject unassigned rider applications')
    }

    const updated = await prisma.rider.update({
      where: { id: existing.id },
      data: {
        approvalStatus: 'rejected',
        active: false,
        rejectedReason: body.reason ?? 'Documents were not accepted',
        reviewedAt: new Date(),
      },
    })

    res.json(updated)
  } catch (error) {
    next(zodFail(error))
  }
})

adminRouter.post('/riders', async (req, res, next) => {
  try {
    const body = z.object({
        storeId: z.string().min(1),
        name: z.string().trim().min(1).max(80),
        phone: z.string().trim().max(40).optional(),
        vehicle: z.string().trim().max(40).optional(),
        notes: z.string().trim().max(240).optional(),
        active: z.boolean().optional(),
      isPrimary: z.boolean().optional(),
      email: z.string().trim().email().optional(),
      password: z.string().min(6).max(120).optional(),
    }).parse(req.body)

    await assertStoreAccess(req.user!, body.storeId)

    if (body.isPrimary) {
      await prisma.rider.updateMany({
        where: { storeId: body.storeId, isPrimary: true },
        data: { isPrimary: false },
      })
    }

    let userId: string | null = null
    if (body.email && body.password) {
      const email = body.email.toLowerCase()
      const existingUser = await prisma.user.findUnique({ where: { email } })
      if (existingUser) throw new HttpError(409, 'That email is already in use')
      const { hashPassword } = await import('../lib/auth.js')
      const passwordHash = await hashPassword(body.password)
      const riderUser = await prisma.user.create({
        data: {
          email,
          passwordHash,
          name: body.name,
          phone: body.phone ?? '',
          role: 'RIDER',
          storeId: body.storeId,
        },
      })
      userId = riderUser.id
    }

    const created = await prisma.rider.create({
      data: {
        storeId: body.storeId,
        userId,
        name: body.name,
        phone: body.phone ?? '',
        vehicle: body.vehicle?.trim() || 'Bike',
        notes: body.notes ?? '',
        active: body.active ?? true,
        isPrimary: body.isPrimary ?? false,
        approvalStatus: 'approved',
        reviewedAt: new Date(),
      },
    })

    res.status(201).json(created)
  } catch (error) {
    next(zodFail(error))
  }
})

adminRouter.patch('/riders/:id', async (req, res, next) => {
  try {
    const existing = await prisma.rider.findUnique({
      where: { id: req.params.id },
    })

    if (!existing) throw new HttpError(404, 'Rider not found')
    if (!existing.storeId) throw new HttpError(400, 'Approve and assign this rider to a store first')

    await assertStoreAccess(req.user!, existing.storeId)

    const body = z.object({
        name: z.string().trim().min(1).max(80).optional(),
        phone: z.string().trim().max(40).optional(),
        vehicle: z.string().trim().max(40).optional(),
        notes: z.string().trim().max(240).optional(),
        active: z.boolean().optional(),
      isPrimary: z.boolean().optional(),
      email: z.string().trim().email().optional(),
      password: z.string().min(6).max(120).optional(),
    }).parse(req.body)

    if (body.isPrimary) {
      await prisma.rider.updateMany({
        where: { storeId: existing.storeId, isPrimary: true, NOT: { id: existing.id } },
        data: { isPrimary: false },
      })
    }

    let userId = existing.userId
    if (body.email && body.password) {
      const email = body.email.toLowerCase()
      const { hashPassword } = await import('../lib/auth.js')
      const passwordHash = await hashPassword(body.password)
      if (userId) {
        await prisma.user.update({
          where: { id: userId },
          data: {
            email,
            passwordHash,
            ...(body.name != null ? { name: body.name } : {}),
            ...(body.phone != null ? { phone: body.phone } : {}),
          },
        })
      } else {
        const clash = await prisma.user.findUnique({ where: { email } })
        if (clash) throw new HttpError(409, 'That email is already in use')
        const riderUser = await prisma.user.create({
          data: {
            email,
            passwordHash,
            name: body.name ?? existing.name,
            phone: body.phone ?? existing.phone,
            role: 'RIDER',
            storeId: existing.storeId,
          },
        })
        userId = riderUser.id
      }
    }

    const updated = await prisma.rider.update({
      where: { id: existing.id },
      data: {
        ...(body.name != null ? { name: body.name } : {}),
        ...(body.phone != null ? { phone: body.phone } : {}),
        ...(body.vehicle != null
          ? { vehicle: body.vehicle.trim() || 'Bike' }
          : {}),
        ...(body.notes != null ? { notes: body.notes } : {}),
        ...(body.active != null ? { active: body.active } : {}),
        ...(body.isPrimary != null ? { isPrimary: body.isPrimary } : {}),
        ...(userId !== existing.userId ? { userId } : {}),
      },
    })

    res.json(updated)
  } catch (error) {
    next(zodFail(error))
  }
})

adminRouter.delete('/riders/:id', async (req, res, next) => {
  try {
    const existing = await prisma.rider.findUnique({
      where: { id: req.params.id },
    })

    if (!existing) throw new HttpError(404, 'Rider not found')
    if (!existing.storeId) throw new HttpError(400, 'This rider is not assigned to a store yet')

    await assertStoreAccess(req.user!, existing.storeId)

    await prisma.rider.delete({ where: { id: existing.id } })

    res.status(204).end()
  } catch (error) {
    next(error)
  }
})

adminRouter.post('/orders/:number/status', async (req, res, next) => {
  try {
    const body = z.object({
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
    }).parse(req.body)

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

    if (
      body.status === 'cancelled' &&
      body.refundAmount &&
      body.refundAmount > 0
    ) {
      await assertStoreAccess(req.user!, order.storeId, {
        requireRefund: true,
      })
    }

    const isCod =
      /cash on delivery|^cod$/i.test(order.paymentLabel || '') || order.paymentStatus === 'unpaid'
    const markCodCollected =
      isCod &&
      order.paymentStatus === 'unpaid' &&
      (body.status === 'delivered' || body.status === 'collected')

    await prisma.order.update({
      where: { id: order.id },
      data: {
        status: body.status,
        ...(body.cancelReason != null
          ? { cancelReason: body.cancelReason }
          : {}),
        ...(body.refundReason != null
          ? { refundReason: body.refundReason }
          : {}),
        ...(body.refundAmount != null
          ? {
              refundAmount: dec(body.refundAmount),
              paymentStatus: body.refundAmount >= money(order.total)
                ? 'refunded'
                : 'partially_refunded',
            }
          : markCodCollected
            ? { paymentStatus: 'paid' }
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

    if (body.refundAmount && body.refundAmount > 0) {
      await writeAudit({
        actorId: req.user!.id,
        storeId: order.storeId,
        action: 'order.refund',
        detail: `Refund ${body.refundAmount} on ${order.number}`,
        meta: { reason: body.refundReason ?? '' },
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
    const body = z.object({
      status: z.enum([
        'pending',
        'needs_clearer_photo',
        'approved',
        'dispensed',
        'rejected',
      ]),
      notes: z.string().max(500).optional(),
      verifiedItems: z.array(
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
      ).optional(),
    }).parse(req.body)

    const prescription = await prisma.prescription.findUnique({
      where: { number: req.params.number },
    })

    if (!prescription) throw new HttpError(404, 'Prescription not found')

    const access = await assertStoreAccess(req.user!, prescription.storeId, {
      roles: ['OWNER', 'STORE_MANAGER', 'PHARMACIST'],
    })

    if (!canReviewPrescriptions(access.deskRole) && req.user!.role !== 'ADMIN') {
      throw new HttpError(403, 'Your role cannot review prescriptions')
    }

    if (
      prescription.status === 'rejected' ||
      prescription.status === 'dispensed'
    ) {
      throw new HttpError(400, 'This prescription is already closed')
    }

    if (body.status === 'dispensed' && prescription.status !== 'approved') {
      throw new HttpError(400, 'Approve the prescription before dispensing')
    }

    if (body.status === 'approved' && !body.verifiedItems?.length) {
      throw new HttpError(
        400,
        'Select verified medicines from the store catalog before approving',
      )
    }

    const reviewedAt = new Date()
    const enrichedItems = []

    for (const item of body.verifiedItems ?? []) {
      if (!item.productId && !item.sku) {
        throw new HttpError(
          400,
          'Verified medicines must come from the store catalog',
        )
      }

      const product = item.productId
        ? await prisma.product.findFirst({
            where: {
              id: item.productId,
              storeId: prescription.storeId,
            },
          })
        : await prisma.product.findFirst({
            where: {
              storeId: prescription.storeId,
              sku: item.sku,
            },
          })

      if (!product) {
        throw new HttpError(
          400,
          `${item.name} is not in this store catalog`,
        )
      }

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
        ...(enrichedItems.length
          ? {
              verifiedItems: enrichedItems,
              medicineName: enrichedItems.map((item) => item.name).join(', '),
            }
          : {}),
        reviewerId: req.user!.id,
        reviewedAt,
        imageReadable: body.status === 'needs_clearer_photo'
          ? false
          : prescription.imageReadable,
      },
    })

    await writeAudit({
      actorId: req.user!.id,
      storeId: prescription.storeId,
      action: 'prescription.review',
      detail: `${updated.number} → ${body.status}`,
      meta: { verifiedCount: enrichedItems.length },
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
      body: body.notes?.trim() ||
        `${updated.number} is now ${body.status.replaceAll('_', ' ')}.`,
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
    if (req.user!.role !== 'ADMIN') {
      throw new HttpError(403, 'Only the main Hera admin can add stores')
    }

    const body = z.object({
      code: z.string()
        .trim()
        .min(2)
        .max(12)
        .regex(/^[A-Za-z0-9_-]+$/, 'Store code must be letters, numbers, - or _'),
        name: z.string().trim().min(1).max(120),
      address: z.string().trim().min(5).max(240),
        openUntil: z.string().trim().min(1).max(40).default('9:00 PM'),
      phone: z.union([
        z.literal(''),
        z.string().trim().regex(
          /^[+()\d\s-]{7,40}$/,
          'Enter a valid phone number',
        ),
      ]).optional(),
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
    }).parse(req.body)

    const code = body.code.toUpperCase()

    const exists = await prisma.store.findUnique({
      where: { code },
    })

    if (exists) {
      throw new HttpError(400, `Store code ${code} is already in use`)
    }

    const status = body.status ?? 'draft'

    const deliveryFees = [
      {
        type: 'standard',
        label: 'Standard',
        fee: body.standardDelivery ?? 3.5,
        eta: 60,
      },
      {
        type: 'express',
        label: 'Express',
        fee: body.expressDelivery ?? 6.5,
        eta: 30,
      },
      {
        type: 'pickup',
        label: 'Pickup',
        fee: 0,
        eta: 20,
      },
    ]

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
          acceptingOrders: status === 'active'
            ? (body.acceptingOrders ?? true)
            : false,
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
          label: `${item.label} delivery`.replace(
            'Pickup delivery',
            'Store pickup',
          ),
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
          deliveryArea: item.type === 'pickup'
            ? ''
            : 'Local delivery area',
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

    const saved = await prisma.store.findUnique({
      where: { id: storeId },
    })

    if (!saved) {
      throw new HttpError(500, 'Store was not saved. Try again.')
    }

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
    if (req.user!.role !== 'ADMIN') {
      throw new HttpError(403, 'Only the main Hera admin can archive stores')
    }

    const store = await prisma.store.findUnique({
      where: { id: req.params.id },
    })

    if (!store) throw new HttpError(404, 'Store not found')

    await prisma.store.update({
      where: { id: store.id },
      data: {
        status: 'archived',
        isOpen: false,
        acceptingOrders: false,
      },
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
    const isOpen = z.object({
      isOpen: z.boolean(),
    }).parse(req.body).isOpen

    await assertStoreAccess(req.user!, req.params.id, {
      roles: ['OWNER', 'STORE_MANAGER'],
    })

    await prisma.store.update({
      where: { id: req.params.id },
      data: isOpen
        ? { isOpen: true }
        : { isOpen: false, acceptingOrders: false },
    })

    res.status(204).end()
  } catch (error) {
    next(zodFail(error))
  }
})

adminRouter.patch('/pharmacies/:id', async (req, res, next) => {
  try {
    if (req.user!.role !== 'ADMIN') {
      await assertStoreAccess(req.user!, req.params.id, {
        roles: ['OWNER', 'STORE_MANAGER'],
      })
    }

    const body = z.object({
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
      city: z.string().trim().max(80).optional(),
      country: z.string().trim().max(80).optional(),
      maxDeliveryDistanceKm: z.number().positive().max(500).nullable().optional(),
      lowStockThreshold: z.number().int().min(0).optional(),
    }).parse(req.body)

    if (
      body.status === 'active' ||
      body.status === 'draft' ||
      body.status === 'archived'
    ) {
      if (req.user!.role !== 'ADMIN') {
        const access = await assertStoreAccess(req.user!, req.params.id, {
          roles: ['OWNER'],
        })

        if (access.deskRole !== 'OWNER') {
          throw new HttpError(
            403,
            'Only the main owner can publish or archive stores',
          )
        }
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
        ...(body.pharmacistUserId !== undefined
          ? { pharmacistUserId: body.pharmacistUserId }
          : {}),
        ...(body.managerUserId !== undefined
          ? { managerUserId: body.managerUserId }
          : {}),
        ...(body.isOpen != null ? { isOpen: body.isOpen } : {}),
        ...(body.acceptingOrders != null
          ? { acceptingOrders: body.acceptingOrders }
          : {}),
        ...(body.status != null
          ? {
              status: body.status,
              ...(body.status === 'active'
                ? {
                    isOpen: true,
                    acceptingOrders: body.acceptingOrders ?? true,
                  }
                : {}),
              ...(body.status === 'paused'
                ? { acceptingOrders: false }
                : {}),
              ...(body.status === 'archived'
                ? { isOpen: false, acceptingOrders: false }
                : {}),
              ...(body.status === 'draft'
                ? { isOpen: false, acceptingOrders: false }
                : {}),
            }
          : {}),
        ...(body.isOpen === false && body.status == null
          ? { isOpen: false, acceptingOrders: false }
          : {}),
        ...(body.weeklyHours != null
          ? { weeklyHours: body.weeklyHours }
          : {}),
        ...(body.closedDays != null
          ? { closedDays: body.closedDays }
          : {}),
        ...(body.holidayHours != null
          ? { holidayHours: body.holidayHours }
          : {}),
        ...(body.mapLat !== undefined ? { mapLat: body.mapLat } : {}),
        ...(body.mapLng !== undefined ? { mapLng: body.mapLng } : {}),
        ...(body.city !== undefined ? { city: body.city } : {}),
        ...(body.country !== undefined ? { country: body.country } : {}),
        ...(body.maxDeliveryDistanceKm !== undefined
          ? { maxDeliveryDistanceKm: body.maxDeliveryDistanceKm }
          : {}),
        ...(body.lowStockThreshold != null
          ? { lowStockThreshold: body.lowStockThreshold }
          : {}),
      },
    })

    if (body.pharmacistUserId) {
      const pharmacist = await prisma.user.findUnique({
        where: { id: body.pharmacistUserId },
      })

      if (pharmacist) {
        await prisma.store.update({
          where: { id: updated.id },
          data: { pharmacist: pharmacist.name },
        })
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
      },
    })

    res.status(204).end()
  } catch (error) {
    next(zodFail(error))
  }
})

adminRouter.get('/customers/:id/activities', async (req, res, next) => {
  try {
    const customer = await prisma.user.findFirst({
      where: {
        id: req.params.id,
        role: 'CUSTOMER',
      },
      select: { id: true },
    })

    if (!customer) {
      throw new HttpError(404, 'Customer not found')
    }

    const activities = await prisma.auditLog.findMany({
      where: {
        actorId: customer.id,
        action: { startsWith: 'customer.' },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true,
        action: true,
        detail: true,
        createdAt: true,
      },
    })

    res.json({ activities })
  } catch (error) {
    next(error)
  }
})
adminRouter.patch('/customers/:id', async (req, res, next) => {
  try {
    const body = z.object({
      name: z.string().trim().min(1).max(100).optional(),
      email: z.string().trim().email().max(160).optional(),
      phone: z.string().trim().max(40).optional(),
      city: z.string().trim().max(80).optional(),
      dateOfBirth: z.string().trim().max(30).optional(),
      gender: z.string().trim().max(30).optional(),
      allergies: z.string().trim().max(300).optional(),
    }).parse(req.body)

    const existing = await prisma.user.findUnique({ where: { id: req.params.id } })
    if (!existing || existing.role !== 'CUSTOMER') {
      throw new HttpError(404, 'Customer not found')
    }

    const nextEmail = body.email ? body.email.toLowerCase() : existing.email
    if (nextEmail !== existing.email) {
      const taken = await prisma.user.findUnique({ where: { email: nextEmail } })
      if (taken && taken.id !== existing.id) {
        throw new HttpError(409, 'That email address is already in use')
      }
    }

    const updated = await prisma.user.update({
      where: { id: existing.id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.email !== undefined ? { email: nextEmail } : {}),
        ...(body.phone !== undefined ? { phone: body.phone } : {}),
        ...(body.city !== undefined ? { city: body.city } : {}),
        ...(body.dateOfBirth !== undefined ? { dateOfBirth: body.dateOfBirth } : {}),
        ...(body.gender !== undefined ? { gender: body.gender } : {}),
        ...(body.allergies !== undefined ? { allergies: body.allergies } : {}),
      },
    })

    await writeAudit({
      actorId: req.user!.id,
      action: 'customer.update',
      detail: `Updated customer ${updated.name}`,
    })

    res.json({
      id: updated.id,
      name: updated.name,
      email: updated.email,
      phone: updated.phone,
      city: updated.city,
      dateOfBirth: updated.dateOfBirth,
      gender: updated.gender,
      allergies: updated.allergies,
    })
  } catch (error) {
    next(zodFail(error))
  }
})
