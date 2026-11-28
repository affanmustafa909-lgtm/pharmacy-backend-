import { Router } from 'express'
import { z } from 'zod'
import { HttpError } from '../lib/http.js'
import { prisma } from '../lib/prisma.js'
import { requireAuth, requireRole } from '../middleware/auth.js'

export const customerComplaintRouter = Router()
customerComplaintRouter.use(requireAuth, requireRole('CUSTOMER'))

const fail = (error: unknown) =>
  error instanceof z.ZodError ? new HttpError(400, error.issues[0]?.message || 'Check the form and try again') : error

// Customer sees only the replies meant for them, never internal admin notes.
const publicNotes = { where: { kind: { in: ['response', 'customer'] } }, orderBy: { createdAt: 'asc' as const } }

function mapComplaint(c: {
  id: string
  number: string
  orderNumber: string
  category: string
  subject: string
  description: string
  status: string
  resolution: string
  createdAt: Date
  notes: { id: string; author: string; kind: string; text: string; createdAt: Date }[]
}) {
  return {
    id: c.id,
    number: c.number,
    orderNumber: c.orderNumber,
    category: c.category,
    subject: c.subject,
    description: c.description,
    status: c.status,
    resolution: c.resolution,
    createdAt: c.createdAt.toISOString(),
    replies: c.notes.map((n) => ({
      id: n.id,
      from: n.kind === 'customer' ? 'You' : 'Pharmacy',
      text: n.text,
      createdAt: n.createdAt.toISOString(),
    })),
  }
}

customerComplaintRouter.post('/', async (req, res, next) => {
  try {
    const body = z
      .object({
        orderNumber: z.string().trim().max(40).optional(),
        category: z.string().trim().max(40).optional(),
        subject: z.string().trim().min(3, 'Write a short subject').max(120),
        description: z.string().trim().min(5, 'Tell us what went wrong').max(1000),
      })
      .parse(req.body)
    let storeId: string | null = null
    if (body.orderNumber) {
      const order = await prisma.order.findFirst({ where: { number: body.orderNumber, customerId: req.user!.id } })
      if (!order) throw new HttpError(400, 'That order was not found in your orders')
      storeId = order.storeId
    }
    const count = await prisma.complaint.count()
    const created = await prisma.complaint.create({
      data: {
        number: `CMP-${1000 + count + 1}`,
        customerId: req.user!.id,
        customerName: req.user!.name,
        storeId,
        orderNumber: body.orderNumber ?? '',
        category: body.category || 'Other',
        subject: body.subject,
        description: body.description,
        notes: { create: [{ author: req.user!.name, kind: 'status', text: 'Complaint received from the customer app' }] },
      },
      include: { notes: publicNotes },
    })
    await prisma.notice.create({
      data: { title: 'New complaint', body: `${created.number}: ${created.subject}`, at: 'Just now', page: 'reports' },
    })
    res.status(201).json(mapComplaint(created))
  } catch (error) {
    next(fail(error))
  }
})

customerComplaintRouter.get('/mine', async (req, res, next) => {
  try {
    const items = await prisma.complaint.findMany({
      where: { customerId: req.user!.id },
      include: { notes: publicNotes },
      orderBy: { createdAt: 'desc' },
      take: 50,
    })
    res.json({ complaints: items.map(mapComplaint) })
  } catch (error) {
    next(error)
  }
})

customerComplaintRouter.post('/:id/reply', async (req, res, next) => {
  try {
    const body = z.object({ text: z.string().trim().min(1, 'Write a message').max(1000) }).parse(req.body)
    const c = await prisma.complaint.findFirst({ where: { id: req.params.id, customerId: req.user!.id } })
    if (!c) throw new HttpError(404, 'Complaint not found')
    if (c.status === 'closed') throw new HttpError(400, 'This complaint is closed')
    await prisma.complaintNote.create({ data: { complaintId: c.id, author: req.user!.name, kind: 'customer', text: body.text } })
    if (c.status === 'responded' || c.status === 'resolved') {
      await prisma.complaint.update({ where: { id: c.id }, data: { status: 'in_review' } })
    }
    await prisma.notice.create({
      data: { title: 'Customer replied', body: `${c.number}: ${body.text.slice(0, 80)}`, at: 'Just now', page: 'reports' },
    })
    res.status(204).end()
  } catch (error) {
    next(fail(error))
  }
})
