import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { HttpError } from '../lib/http.js'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { notifyCustomer } from '../services/notifications.js'

function mapReminder(item: {
  id: string
  medicine: string
  time: string
  frequency: string
  enabled: boolean
  adherence: number
  productId: string | null
  orderNumber: string | null
  snoozedUntil: Date | null
}) {
  return {
    id: item.id,
    medicine: item.medicine,
    time: item.time,
    frequency: item.frequency,
    enabled: item.enabled,
    adherence: item.adherence,
    productId: item.productId,
    orderNumber: item.orderNumber,
    snoozedUntil: item.snoozedUntil?.toISOString() ?? null,
  }
}

export const reminderRouter = Router()
reminderRouter.use(requireAuth, requireRole('CUSTOMER'))

reminderRouter.get('/mine', async (req, res) => {
  const reminders = await prisma.reminder.findMany({
    where: {
      OR: [{ customerId: req.user!.id }, { customerId: null, customerName: { equals: req.user!.name, mode: 'insensitive' } }],
    },
    orderBy: { medicine: 'asc' },
  })
  res.json({ reminders: reminders.map(mapReminder) })
})

reminderRouter.post('/', async (req, res, next) => {
  try {
    const body = z
      .object({
        medicine: z.string().trim().min(1).max(120),
        time: z.string().trim().min(1).max(40),
        frequency: z.string().trim().min(1).max(80),
        productId: z.string().optional(),
        orderNumber: z.string().optional(),
      })
      .parse(req.body)
    const created = await prisma.reminder.create({
      data: {
        customerId: req.user!.id,
        customerName: req.user!.name,
        medicine: body.medicine,
        time: body.time,
        frequency: body.frequency,
        productId: body.productId || null,
        orderNumber: body.orderNumber || null,
        enabled: true,
      },
    })
    res.status(201).json({ reminder: mapReminder(created) })
  } catch (error) {
    next(error instanceof z.ZodError ? new HttpError(400, 'Check the reminder details') : error)
  }
})

reminderRouter.patch('/:id', async (req, res, next) => {
  try {
    const existing = await prisma.reminder.findUnique({ where: { id: req.params.id } })
    if (!existing) throw new HttpError(404, 'Reminder not found')
    const owned =
      existing.customerId === req.user!.id ||
      (!existing.customerId && existing.customerName.toLowerCase() === req.user!.name.toLowerCase())
    if (!owned) throw new HttpError(403, 'You cannot change this reminder')
    const body = z
      .object({
        medicine: z.string().trim().min(1).max(120).optional(),
        time: z.string().trim().min(1).max(40).optional(),
        frequency: z.string().trim().min(1).max(80).optional(),
        enabled: z.boolean().optional(),
        productId: z.string().nullable().optional(),
        orderNumber: z.string().nullable().optional(),
      })
      .parse(req.body)
    const updated = await prisma.reminder.update({
      where: { id: existing.id },
      data: {
        customerId: existing.customerId ?? req.user!.id,
        ...(body.medicine != null ? { medicine: body.medicine } : {}),
        ...(body.time != null ? { time: body.time } : {}),
        ...(body.frequency != null ? { frequency: body.frequency } : {}),
        ...(body.enabled != null ? { enabled: body.enabled } : {}),
        ...(body.productId !== undefined ? { productId: body.productId } : {}),
        ...(body.orderNumber !== undefined ? { orderNumber: body.orderNumber } : {}),
      },
    })
    res.json({ reminder: mapReminder(updated) })
  } catch (error) {
    next(error instanceof z.ZodError ? new HttpError(400, 'Check the reminder details') : error)
  }
})

reminderRouter.post('/:id/toggle', async (req, res, next) => {
  try {
    const existing = await prisma.reminder.findUnique({ where: { id: req.params.id } })
    if (!existing) throw new HttpError(404, 'Reminder not found')
    const owned =
      existing.customerId === req.user!.id ||
      (!existing.customerId && existing.customerName.toLowerCase() === req.user!.name.toLowerCase())
    if (!owned) throw new HttpError(403, 'You cannot change this reminder')
    const updated = await prisma.reminder.update({
      where: { id: existing.id },
      data: { enabled: !existing.enabled, customerId: existing.customerId ?? req.user!.id, snoozedUntil: null },
    })
    res.json({ id: updated.id, enabled: updated.enabled })
  } catch (error) {
    next(error)
  }
})

reminderRouter.post('/:id/snooze', async (req, res, next) => {
  try {
    const hours = z.object({ hours: z.number().int().min(1).max(72).default(4) }).parse(req.body).hours
    const existing = await prisma.reminder.findUnique({ where: { id: req.params.id } })
    if (!existing) throw new HttpError(404, 'Reminder not found')
    const owned =
      existing.customerId === req.user!.id ||
      (!existing.customerId && existing.customerName.toLowerCase() === req.user!.name.toLowerCase())
    if (!owned) throw new HttpError(403, 'You cannot change this reminder')
    const snoozedUntil = new Date(Date.now() + hours * 60 * 60 * 1000)
    const updated = await prisma.reminder.update({
      where: { id: existing.id },
      data: {
        enabled: false,
        snoozedUntil,
        customerId: existing.customerId ?? req.user!.id,
      },
    })
    await notifyCustomer({
      customerId: req.user!.id,
      type: 'refill',
      title: 'Reminder snoozed',
      body: `${updated.medicine} is snoozed for ${hours} hours.`,
      data: { reminderId: updated.id, productId: updated.productId, orderNumber: updated.orderNumber },
    })
    res.json({ reminder: mapReminder(updated) })
  } catch (error) {
    next(error instanceof z.ZodError ? new HttpError(400, 'Check the snooze details') : error)
  }
})

reminderRouter.delete('/:id', async (req, res, next) => {
  try {
    const existing = await prisma.reminder.findUnique({ where: { id: req.params.id } })
    if (!existing) throw new HttpError(404, 'Reminder not found')
    const owned =
      existing.customerId === req.user!.id ||
      (!existing.customerId && existing.customerName.toLowerCase() === req.user!.name.toLowerCase())
    if (!owned) throw new HttpError(403, 'You cannot change this reminder')
    await prisma.reminder.delete({ where: { id: existing.id } })
    res.status(204).end()
  } catch (error) {
    next(error)
  }
})
