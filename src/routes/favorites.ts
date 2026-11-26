import { Router } from 'express'
import { z } from 'zod'
import { HttpError } from '../lib/http.js'
import { prisma } from '../lib/prisma.js'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { money } from '../services/money.js'

export const favoritesRouter = Router()
favoritesRouter.use(requireAuth, requireRole('CUSTOMER'))

favoritesRouter.get('/mine', async (req, res, next) => {
  try {
    const rows = await prisma.customerFavorite.findMany({
      where: { customerId: req.user!.id },
      include: {
        product: {
          include: { store: { select: { id: true, name: true, status: true, acceptingOrders: true } } },
        },
      },
      orderBy: { createdAt: 'desc' },
    })
    res.json({
      productIds: rows.map((row) => row.productId),
      favorites: rows.map((row) => ({
        id: row.id,
        productId: row.productId,
        createdAt: row.createdAt.toISOString(),
        product: {
          id: row.product.id,
          name: row.product.name,
          brand: row.product.brand,
          price: money(row.product.price),
          stock: row.product.stock,
          imageUrl: row.product.imageUrl,
          rxRequired: row.product.rxRequired,
          inStock: row.product.stock > 0 && !row.product.held && row.product.onlineSale,
          storeId: row.product.storeId,
          storeName: row.product.store.name,
          available:
            row.product.stock > 0 &&
            !row.product.held &&
            row.product.onlineSale &&
            row.product.published &&
            row.product.store.status === 'active' &&
            row.product.store.acceptingOrders,
        },
      })),
    })
  } catch (error) {
    next(error)
  }
})

favoritesRouter.post('/', async (req, res, next) => {
  try {
    const body = z.object({ productId: z.string().min(1) }).parse(req.body)
    const product = await prisma.product.findUnique({ where: { id: body.productId } })
    if (!product) throw new HttpError(404, 'Product not found')
    const favorite = await prisma.customerFavorite.upsert({
      where: {
        customerId_productId: {
          customerId: req.user!.id,
          productId: body.productId,
        },
      },
      create: { customerId: req.user!.id, productId: body.productId },
      update: {},
    })
    res.status(201).json({ productId: favorite.productId })
  } catch (error) {
    next(error instanceof z.ZodError ? new HttpError(400, 'Product is required') : error)
  }
})

favoritesRouter.delete('/:productId', async (req, res, next) => {
  try {
    await prisma.customerFavorite.deleteMany({
      where: { customerId: req.user!.id, productId: req.params.productId },
    })
    res.status(204).end()
  } catch (error) {
    next(error)
  }
})
