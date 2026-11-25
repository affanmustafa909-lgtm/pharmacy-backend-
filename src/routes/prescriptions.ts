import { createHash, randomBytes } from 'node:crypto'
import { Router } from 'express'
import fs from 'node:fs'
import path from 'node:path'
import multer from 'multer'
import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { HttpError } from '../lib/http.js'
import { prisma } from '../lib/prisma.js'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { notifyCustomer } from '../services/notifications.js'

const uploadDir = path.resolve('uploads/prescriptions')
fs.mkdirSync(uploadDir, { recursive: true })

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase() || '.jpg'
      // A long random name: the photo link cannot be guessed, because these are patients' prescriptions.
      cb(null, `rx-${randomBytes(16).toString('hex')}${ext}`)
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) return cb(new HttpError(400, 'Choose an image file'))
    return cb(null, true)
  },
})

function hashFile(filePath: string) {
  const bytes = fs.readFileSync(filePath)
  return createHash('sha256').update(bytes).digest('hex')
}

/** If the request fails after the photo was saved, remove the photo so no orphan file stays on disk. */
function discardUpload(file?: { filename: string }) {
  if (!file) return
  fs.unlink(path.join(uploadDir, file.filename), () => undefined)
}

function assessReadable(scannedText: string, fileSize: number) {
  const text = scannedText.trim()
  if (fileSize < 8_000) return false
  if (!text) return true
  // Reject OCR payloads that look like they belong to a different scene (very short junk is ok)
  return text.length >= 3
}

function mapPrescription(item: {
  number: string
  status: string
  medicineName: string
  prescriber: string
  quantity: string
  imageUrl: string
  imageHash?: string
  imageReadable?: boolean
  scannedText: string
  verifiedItems: unknown
  customerNote: string
  notes: string
  storeId: string
  submittedAt: Date
  updatedAt: Date
  store?: { name: string; address: string }
}) {
  return {
    id: item.number,
    number: item.number,
    status: item.status,
    medicineName: item.medicineName,
    prescriber: item.prescriber,
    quantity: item.quantity,
    imageUrl: item.imageUrl,
    imageHash: item.imageHash ?? '',
    imageReadable: item.imageReadable ?? true,
    scannedText: item.scannedText,
    verifiedItems: Array.isArray(item.verifiedItems) ? item.verifiedItems : [],
    customerNote: item.customerNote,
    notes: item.notes,
    storeId: item.storeId,
    storeName: item.store?.name ?? '',
    storeAddress: item.store?.address ?? '',
    submittedAt: item.submittedAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  }
}

export const prescriptionRouter = Router()
prescriptionRouter.use(requireAuth, requireRole('CUSTOMER'))

prescriptionRouter.get('/mine', async (req, res) => {
  const items = await prisma.prescription.findMany({
    where: { customerId: req.user!.id },
    include: { store: true },
    orderBy: { submittedAt: 'desc' },
    take: 50,
  })
  res.json({ prescriptions: items.map(mapPrescription) })
})

prescriptionRouter.get('/:number', async (req, res, next) => {
  try {
    const item = await prisma.prescription.findFirst({
      where: { number: req.params.number, customerId: req.user!.id },
      include: { store: true },
    })
    if (!item) throw new HttpError(404, 'Prescription not found')
    res.json({ prescription: mapPrescription(item) })
  } catch (error) {
    next(error)
  }
})

prescriptionRouter.post('/', (req, res, next) => {
  upload.single('image')(req, res, async (uploadError) => {
    try {
      if (uploadError) throw uploadError
      const body = z
        .object({
          storeId: z.string().min(1),
          scannedText: z.string().max(4000).optional(),
          imageHash: z.string().max(128).optional(),
          customerNote: z.string().max(500).optional(),
          medicineName: z.string().max(120).optional(),
          prescriber: z.string().max(120).optional(),
          quantity: z.string().max(80).optional(),
        })
        .parse({
          storeId: req.body.storeId,
          scannedText: req.body.scannedText,
          imageHash: req.body.imageHash,
          customerNote: req.body.customerNote,
          medicineName: req.body.medicineName,
          prescriber: req.body.prescriber,
          quantity: req.body.quantity,
        })
      const store = await prisma.store.findUnique({ where: { id: body.storeId } })
      if (!store) throw new HttpError(404, 'Store not found')
      if (!req.file) throw new HttpError(400, 'Upload a prescription photo')
      const filePath = path.join(uploadDir, req.file.filename)
      // The hash always comes from the real saved file. A hash sent by the app is not trusted.
      const imageHash = hashFile(filePath)
      const scannedText = body.scannedText?.trim() || ''
      // OCR text is only kept when it is submitted with this upload (same request)
      const boundText = scannedText
      const readable = assessReadable(boundText, req.file.size)

      // Two uploads at the same moment could pick the same number. If that happens, try the next one.
      let created: Prisma.PrescriptionGetPayload<{ include: { store: true } }> | null = null
      for (let attempt = 0; attempt < 5 && !created; attempt += 1) {
        const count = await prisma.prescription.count()
        const number = `PX-${2200 + count + 1 + attempt}`
        try {
          created = await prisma.prescription.create({
            data: {
              number,
              customerId: req.user!.id,
              customerName: req.user!.name,
              storeId: body.storeId,
              medicineName: body.medicineName?.trim() || 'Pending pharmacist review',
              prescriber: body.prescriber?.trim() || '',
              quantity: body.quantity?.trim() || '',
              imageUrl: `/uploads/prescriptions/${req.file.filename}`,
              imageHash,
              scannedText: boundText,
              imageReadable: readable,
              customerNote: body.customerNote?.trim() || '',
              status: readable ? 'pending' : 'needs_clearer_photo',
              notes: readable ? '' : 'Photo looks unreadable. Please replace with a clearer prescription image.',
              verifiedItems: [],
            },
            include: { store: true },
          })
        } catch (error) {
          const numberTaken = error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
          if (!numberTaken) throw error
        }
      }
      if (!created) throw new HttpError(503, 'Could not save the prescription. Please try again.')

      await prisma.notice.create({
        data: {
          title: readable ? 'Prescription to review' : 'Unreadable prescription photo',
          body: `${created.number} from ${req.user!.name} ${readable ? 'needs review' : 'needs a clearer photo'}.`,
          at: 'Just now',
          page: 'prescriptions',
        },
      })
      await notifyCustomer({
        customerId: req.user!.id,
        type: 'prescription',
        title: readable ? 'Prescription received' : 'Clearer photo needed',
        body: readable
          ? `${created.number} is pending pharmacist review.`
          : `${created.number} could not be read. Replace the photo on this request.`,
        data: { prescriptionNumber: created.number, status: created.status },
      })
      res.status(201).json({ prescription: mapPrescription(created) })
    } catch (error) {
      discardUpload(req.file)
      next(error instanceof z.ZodError ? new HttpError(400, 'Check the prescription details') : error)
    }
  })
})

prescriptionRouter.post('/:number/replace-image', (req, res, next) => {
  upload.single('image')(req, res, async (uploadError) => {
    try {
      if (uploadError) throw uploadError
      const existing = await prisma.prescription.findFirst({
        where: { number: req.params.number, customerId: req.user!.id },
        include: { store: true },
      })
      if (!existing) throw new HttpError(404, 'Prescription not found')
      if (existing.status !== 'needs_clearer_photo' && existing.status !== 'pending') {
        throw new HttpError(400, 'This prescription cannot be updated')
      }
      if (!req.file) throw new HttpError(400, 'Upload a clearer prescription photo')
      const filePath = path.join(uploadDir, req.file.filename)
      const imageHash = hashFile(filePath)
      // Always replace OCR with text from this same upload request — never keep stale OCR from a prior photo
      const scannedText = String(req.body.scannedText ?? '').trim()
      const readable = assessReadable(scannedText, req.file.size)
      const updated = await prisma.prescription.update({
        where: { id: existing.id },
        data: {
          imageUrl: `/uploads/prescriptions/${req.file.filename}`,
          imageHash,
          scannedText,
          imageReadable: readable,
          status: readable ? 'pending' : 'needs_clearer_photo',
          notes: readable
            ? 'Customer uploaded a clearer photo.'
            : 'Replacement photo is still unreadable. Please try again with better lighting.',
        },
        include: { store: true },
      })
      await prisma.notice.create({
        data: {
          title: 'Prescription photo updated',
          body: `${updated.number} has a new photo for review.`,
          at: 'Just now',
          page: 'prescriptions',
        },
      })
      await notifyCustomer({
        customerId: req.user!.id,
        type: 'prescription',
        title: readable ? 'Photo received' : 'Photo still unclear',
        body: readable
          ? `${updated.number} is back in the pharmacist queue.`
          : `${updated.number} still needs a clearer photo.`,
        data: { prescriptionNumber: updated.number, status: updated.status },
      })
      res.json({ prescription: mapPrescription(updated) })
    } catch (error) {
      discardUpload(req.file)
      next(error)
    }
  })
})