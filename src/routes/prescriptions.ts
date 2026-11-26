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
import {
  extractCandidatesFromText,
  matchCatalog,
  stockAcrossStores,
  type DetectedMedicine,
} from '../services/catalogMatch.js'
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

const detectedSchema = z.object({
  name: z.string().max(120).optional(),
  strength: z.string().max(40).optional(),
  form: z.string().max(40).optional(),
  packSize: z.string().max(40).optional(),
  confidence: z.number().min(0).max(1).optional(),
  unclear: z.boolean().optional(),
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
  if (fileSize < 8_000) return false
  const text = scannedText.trim()
  if (!text) return true
  return text.length >= 3
}

function parseDetected(raw: unknown): DetectedMedicine {
  if (raw == null || raw === '') return {}
  if (typeof raw === 'string') {
    try {
      return detectedSchema.parse(JSON.parse(raw))
    } catch {
      return {}
    }
  }
  try {
    return detectedSchema.parse(raw)
  } catch {
    return {}
  }
}

function mapPrescription(item: {
  number: string
  status: string
  uploadType?: string
  medicineName: string
  prescriber: string
  quantity: string
  imageUrl: string
  imageHash?: string
  imageReadable?: boolean
  scannedText: string
  detectedDetails?: unknown
  linkedProductId?: string | null
  verifiedItems: unknown
  customerNote: string
  notes: string
  storeId: string
  submittedAt: Date
  updatedAt: Date
  store?: { name: string; address: string }
}) {
  const detected =
    item.detectedDetails && typeof item.detectedDetails === 'object' && !Array.isArray(item.detectedDetails)
      ? (item.detectedDetails as DetectedMedicine)
      : {}
  return {
    id: item.number,
    number: item.number,
    status: item.status,
    uploadType: item.uploadType || 'prescription',
    medicineName: item.medicineName,
    prescriber: item.prescriber,
    quantity: item.quantity,
    imageUrl: item.imageUrl,
    imageHash: item.imageHash ?? '',
    imageReadable: item.imageReadable ?? true,
    scannedText: item.scannedText,
    detectedDetails: detected,
    linkedProductId: item.linkedProductId ?? null,
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

prescriptionRouter.post('/identify', async (req, res, next) => {
  try {
    const body = z
      .object({
        scannedText: z.string().max(4000).optional(),
        hintName: z.string().max(120).optional(),
        storeId: z.string().optional(),
      })
      .parse(req.body)

    const fromText = extractCandidatesFromText(body.scannedText || body.hintName || '')
    if (body.hintName?.trim() && (!fromText.name || fromText.unclear)) {
      fromText.name = body.hintName.trim()
      fromText.unclear = false
      fromText.confidence = Math.max(fromText.confidence ?? 0, 0.5)
    }

    const matches = await matchCatalog({
      storeId: body.storeId,
      detected: fromText,
      limit: 8,
    })

    res.json({
      detected: fromText,
      matches,
      multiple: matches.length > 1,
      unclear: Boolean(fromText.unclear) || matches.length === 0,
    })
  } catch (error) {
    next(error instanceof z.ZodError ? new HttpError(400, 'Check identification details') : error)
  }
})

prescriptionRouter.post('/match', async (req, res, next) => {
  try {
    const body = z
      .object({
        storeId: z.string().optional(),
        detected: detectedSchema,
      })
      .parse(req.body)

    const detected = body.detected as DetectedMedicine
    const matches = await matchCatalog({ storeId: body.storeId, detected, limit: 8 })
    const primary = matches[0] ?? null
    let otherStores: Awaited<ReturnType<typeof stockAcrossStores>> = []
    if (primary && (!primary.inStock || (body.storeId && primary.storeId === body.storeId && primary.stock <= 0))) {
      otherStores = await stockAcrossStores({
        sku: primary.sku,
        excludeStoreId: body.storeId,
      })
    } else if (primary && body.storeId && primary.storeId !== body.storeId) {
      otherStores = []
    } else if (primary && !primary.inStock) {
      otherStores = await stockAcrossStores({ sku: primary.sku, excludeStoreId: primary.storeId })
    }

    // If selected store match is OOS, find same SKU elsewhere
    if (primary && body.storeId) {
      const atSelected = matches.find((row) => row.storeId === body.storeId)
      if (atSelected && !atSelected.inStock) {
        otherStores = await stockAcrossStores({ sku: atSelected.sku, excludeStoreId: body.storeId })
      }
    }

    res.json({
      detected,
      matches,
      multiple: matches.length > 1,
      unmatched: matches.length === 0,
      primary,
      otherStores,
    })
  } catch (error) {
    next(error instanceof z.ZodError ? new HttpError(400, 'Check medicine details') : error)
  }
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
          uploadType: z.enum(['medicine_packaging', 'prescription']).default('prescription'),
          scannedText: z.string().max(4000).optional(),
          imageHash: z.string().max(128).optional(),
          customerNote: z.string().max(500).optional(),
          medicineName: z.string().max(120).optional(),
          prescriber: z.string().max(120).optional(),
          quantity: z.string().max(80).optional(),
          linkedProductId: z.string().optional(),
          detectedDetails: z.string().max(2000).optional(),
        })
        .parse({
          storeId: req.body.storeId,
          uploadType: req.body.uploadType || 'prescription',
          scannedText: req.body.scannedText,
          imageHash: req.body.imageHash,
          customerNote: req.body.customerNote,
          medicineName: req.body.medicineName,
          prescriber: req.body.prescriber,
          quantity: req.body.quantity,
          linkedProductId: req.body.linkedProductId,
          detectedDetails: req.body.detectedDetails,
        })
      const store = await prisma.store.findUnique({ where: { id: body.storeId } })
      if (!store) throw new HttpError(404, 'Store not found')
      if (!req.file) throw new HttpError(400, 'Upload a photo')
      if (req.file.size < 8_000) {
        throw new HttpError(400, 'Photo is too small or unclear. Retake with better lighting.')
      }

      const filePath = path.join(uploadDir, req.file.filename)
      // The hash always comes from the real saved file. A hash sent by the app is not trusted.
      const imageHash = hashFile(filePath)
      // OCR text is only kept when it is submitted with this upload (same request)
      const scannedText = body.scannedText?.trim() || ''
      const detected = parseDetected(body.detectedDetails)
      const readable = assessReadable(scannedText, req.file.size) && !detected.unclear
      const medicineName =
        body.medicineName?.trim() ||
        detected.name?.trim() ||
        (body.uploadType === 'medicine_packaging' ? 'Medicine packaging review' : 'Pending pharmacist review')

      let linkedProductId = body.linkedProductId?.trim() || null
      if (linkedProductId) {
        const product = await prisma.product.findFirst({
          where: { id: linkedProductId, storeId: body.storeId },
        })
        if (!product) linkedProductId = null
      }

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
              uploadType: body.uploadType,
              medicineName,
              prescriber: body.prescriber?.trim() || '',
              quantity: body.quantity?.trim() || detected.packSize || '',
              imageUrl: `/uploads/prescriptions/${req.file.filename}`,
              imageHash,
              scannedText,
              imageReadable: readable,
              detectedDetails: detected,
              linkedProductId,
              customerNote: body.customerNote?.trim() || '',
              status: readable ? 'pending' : 'needs_clearer_photo',
              notes: readable
                ? ''
                : 'Photo looks unreadable. Please replace with a clearer image.',
              verifiedItems: [],
            },
            include: { store: true },
          })
        } catch (error) {
          const numberTaken =
            error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
          if (!numberTaken) throw error
        }
      }
      if (!created) throw new HttpError(503, 'Could not save the prescription. Please try again.')

      const kindLabel = body.uploadType === 'medicine_packaging' ? 'Photo request' : 'Prescription'
      await prisma.notice.create({
        data: {
          title: readable ? `${kindLabel} to review` : `Unreadable ${kindLabel.toLowerCase()}`,
          body: `${created.number} from ${req.user!.name} ${readable ? 'needs review' : 'needs a clearer photo'}.`,
          at: 'Just now',
          page: 'prescriptions',
        },
      })
      await notifyCustomer({
        customerId: req.user!.id,
        type: 'prescription',
        title: readable ? 'Request received' : 'Clearer photo needed',
        body: readable
          ? `${created.number} is pending pharmacist review.`
          : `${created.number} could not be read. Replace the photo on this request.`,
        data: { prescriptionNumber: created.number, status: created.status, uploadType: created.uploadType },
      })
      res.status(201).json({ prescription: mapPrescription(created) })
    } catch (error) {
      discardUpload(req.file)
      next(error instanceof z.ZodError ? new HttpError(400, 'Check the photo request details') : error)
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
      if (!existing) throw new HttpError(404, 'Request not found')
      if (existing.status !== 'needs_clearer_photo' && existing.status !== 'pending') {
        throw new HttpError(400, 'This request cannot be updated')
      }
      if (!req.file) throw new HttpError(400, 'Upload a clearer photo')
      if (req.file.size < 8_000) {
        throw new HttpError(400, 'Photo is too small or unclear. Retake with better lighting.')
      }
      const filePath = path.join(uploadDir, req.file.filename)
      // Always hash the saved file; never trust a client-supplied hash.
      // Always replace OCR with text from this same upload request — never keep stale OCR from a prior photo.
      const imageHash = hashFile(filePath)
      const scannedText = String(req.body.scannedText ?? '').trim()
      const detected = parseDetected(req.body.detectedDetails)
      const readable = assessReadable(scannedText, req.file.size) && !detected.unclear
      const updated = await prisma.prescription.update({
        where: { id: existing.id },
        data: {
          imageUrl: `/uploads/prescriptions/${req.file.filename}`,
          imageHash,
          scannedText,
          imageReadable: readable,
          detectedDetails: Object.keys(detected).length
            ? detected
            : (existing.detectedDetails as object) ?? {},
          status: readable ? 'pending' : 'needs_clearer_photo',
          notes: readable
            ? 'Customer uploaded a clearer photo.'
            : 'Replacement photo is still unreadable. Please try again with better lighting.',
        },
        include: { store: true },
      })
      await prisma.notice.create({
        data: {
          title: 'Photo request updated',
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