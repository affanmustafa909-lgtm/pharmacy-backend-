import { Router } from 'express'
import { z } from 'zod'
import { HttpError } from '../lib/http.js'
import { prisma } from '../lib/prisma.js'
import { requireAuth, requireRole } from '../middleware/auth.js'

const addressInput = z.object({
  label: z.string().trim().min(1).max(40),
  line: z.string().trim().min(1).max(240),
  isDefault: z.boolean().optional(),
})

export const addressRouter = Router()
addressRouter.use(requireAuth, requireRole('CUSTOMER'))

addressRouter.get('/mine', async (req, res) => {
  const addresses = await prisma.customerAddress.findMany({
    where: { customerId: req.user!.id },
    orderBy: [{ isDefault: 'desc' }, { label: 'asc' }],
  })
  res.json({
    addresses: addresses.map((item) => ({
      id: item.id,
      label: item.label,
      line: item.line,
      isDefault: item.isDefault,
    })),
  })
})

addressRouter.post('/', async (req, res, next) => {
  try {
    const body = addressInput.parse(req.body)
    const count = await prisma.customerAddress.count({ where: { customerId: req.user!.id } })
    const created = await prisma.customerAddress.create({
      data: {
        customerId: req.user!.id,
        label: body.label,
        line: body.line,
        isDefault: body.isDefault ?? count === 0,
      },
    })
    if (created.isDefault) {
      await prisma.customerAddress.updateMany({
        where: { customerId: req.user!.id, NOT: { id: created.id } },
        data: { isDefault: false },
      })
    }
    res.status(201).json(created)
  } catch (error) {
    next(error instanceof z.ZodError ? new HttpError(400, 'Check the address') : error)
  }
})

addressRouter.patch('/:id', async (req, res, next) => {
  try {
    const body = addressInput.partial().parse(req.body)
    const existing = await prisma.customerAddress.findUnique({ where: { id: req.params.id } })
    if (!existing || existing.customerId !== req.user!.id) throw new HttpError(404, 'Address not found')
    const updated = await prisma.customerAddress.update({
      where: { id: existing.id },
      data: {
        label: body.label,
        line: body.line,
        isDefault: body.isDefault,
      },
    })
    if (updated.isDefault) {
      await prisma.customerAddress.updateMany({
        where: { customerId: req.user!.id, NOT: { id: updated.id } },
        data: { isDefault: false },
      })
    }
    res.json(updated)
  } catch (error) {
    next(error instanceof z.ZodError ? new HttpError(400, 'Check the address') : error)
  }
})

addressRouter.delete('/:id', async (req, res, next) => {
  try {
    const existing = await prisma.customerAddress.findUnique({ where: { id: req.params.id } })
    if (!existing || existing.customerId !== req.user!.id) throw new HttpError(404, 'Address not found')
    await prisma.customerAddress.delete({ where: { id: existing.id } })
    res.status(204).end()
  } catch (error) {
    next(error)
  }
})
