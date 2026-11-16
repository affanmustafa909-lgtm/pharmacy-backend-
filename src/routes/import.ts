import { Router } from 'express'
import multer from 'multer'
import { z } from 'zod'
import { HttpError } from '../lib/http.js'
import { prisma } from '../lib/prisma.js'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { dec } from '../services/money.js'
import { assertStoreAccess, accessibleStoreIds } from '../services/permissions.js'
import { IMPORT_FIELDS, previewRows, suggestMap, templateBuffer, workbookFromUpload, type ImportField } from '../services/importProducts.js'
import type { AuthUser } from '../lib/auth.js'

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } })
const mapSchema = z.object(Object.fromEntries(IMPORT_FIELDS.map((field) => [field, z.string()])) as Record<ImportField, z.ZodString>)

async function resolveImportScope(user: AuthUser, storeId?: string | null) {
  const allowed = await accessibleStoreIds(user!)
  if (storeId) {
    await assertStoreAccess(user!, storeId, { roles: ['OWNER', 'STORE_MANAGER'] })
    return storeId
  }
  if (allowed?.length === 1) return allowed[0]
  return null
}

export const importRouter = Router()
importRouter.use(requireAuth, requireRole('ADMIN', 'STAFF'))

importRouter.get('/template', async (_req, res) => {
  const file = await templateBuffer()
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  res.setHeader('Content-Disposition', 'attachment; filename="hera-products-template.xlsx"')
  res.send(file)
})

importRouter.post('/upload', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) throw new HttpError(400, 'Choose an Excel file')
    const storeId = typeof req.body.storeId === 'string' ? req.body.storeId : null
    const forcedStoreId = await resolveImportScope(req.user!, storeId)
    const parsed = await workbookFromUpload(req.file.buffer)
    const suggestedMap = suggestMap(parsed.headers)
    const allowed = await accessibleStoreIds(req.user!)
    const rows = await previewRows(
      parsed.headers,
      parsed.rows,
      suggestedMap,
      allowed?.length === 1 ? allowed[0] : forcedStoreId,
      parsed.embeddedImageUrls,
      forcedStoreId,
    )
    res.json({
      headers: parsed.headers,
      rawRows: parsed.rows,
      embeddedImageUrls: parsed.embeddedImageUrls,
      suggestedMap,
      storeId: forcedStoreId,
      rows,
    })
  } catch (error) {
    next(error)
  }
})

importRouter.post('/preview', async (req, res, next) => {
  try {
    const body = z
      .object({
        headers: z.array(z.string()).min(1),
        rawRows: z.array(z.array(z.string())).max(1000),
        embeddedImageUrls: z.array(z.string()).max(1000).optional(),
        map: mapSchema,
        storeId: z.string().optional(),
      })
      .parse(req.body)
    const forcedStoreId = await resolveImportScope(req.user!, body.storeId)
    const allowed = await accessibleStoreIds(req.user!)
    const rows = await previewRows(
      body.headers,
      body.rawRows,
      body.map,
      allowed?.length === 1 ? allowed[0] : forcedStoreId,
      body.embeddedImageUrls ?? [],
      forcedStoreId,
    )
    res.json({ rows, storeId: forcedStoreId })
  } catch (error) {
    next(error instanceof z.ZodError ? new HttpError(400, 'Column mapping is incomplete') : error)
  }
})

importRouter.post('/commit', async (req, res, next) => {
  try {
    const body = z
      .object({
        headers: z.array(z.string()).min(1),
        rawRows: z.array(z.array(z.string())).max(1000),
        embeddedImageUrls: z.array(z.string()).max(1000).optional(),
        map: mapSchema,
        duplicateStrategy: z.enum(['skip', 'update', 'reject']),
        storeId: z.string().optional(),
      })
      .parse(req.body)
    const forcedStoreId = await resolveImportScope(req.user!, body.storeId)
    const allowed = await accessibleStoreIds(req.user!)
    const rows = await previewRows(
      body.headers,
      body.rawRows,
      body.map,
      allowed?.length === 1 ? allowed[0] : forcedStoreId,
      body.embeddedImageUrls ?? [],
      forcedStoreId,
    )
    const saved: number[] = []
    const skipped: number[] = []
    const failed: { rowNumber: number; errors: string[]; values?: Record<string, string> }[] = rows
      .filter((row) => row.errors.length > 0)
      .map((row) => ({ rowNumber: row.rowNumber, errors: row.errors, values: row.values }))

    if (rows.filter((row) => row.errors.length === 0).length === 0) {
      res.json({ saved: 0, skipped: 0, failed, imported: 0 })
      return
    }

    for (const row of rows) {
      if (!row.normalized || row.errors.length > 0) continue
      if (row.duplicate && body.duplicateStrategy === 'reject') {
        failed.push({
          rowNumber: row.rowNumber,
          errors: ['A product with this SKU already exists in the store'],
          values: row.values,
        })
        continue
      }
      if (row.duplicate && body.duplicateStrategy === 'skip') {
        skipped.push(row.rowNumber)
        continue
      }
      try {
        await assertStoreAccess(req.user!, row.normalized.storeId, { roles: ['OWNER', 'STORE_MANAGER'] })
        const data = {
          name: row.normalized.name,
          brand: row.normalized.brand,
          genericName: row.normalized.genericName,
          strength: row.normalized.strength,
          category: row.normalized.category,
          unitLabel: row.normalized.unitLabel,
          price: dec(row.normalized.price),
          stock: row.normalized.stock,
          description: row.normalized.description,
          rxRequired: row.normalized.rxRequired,
          onlineSale: row.normalized.onlineSale,
          batch: row.normalized.batch,
          expiry: row.normalized.expiry,
          imageUrl: row.normalized.imageUrl,
        }
        let productId = ''
        if (row.duplicate && body.duplicateStrategy === 'update') {
          const updated = await prisma.product.update({
            where: { storeId_sku: { storeId: row.normalized.storeId, sku: row.normalized.sku } },
            data,
          })
          productId = updated.id
          await prisma.inventoryBatch.deleteMany({ where: { productId } })
        } else {
          const created = await prisma.product.create({
            data: { ...data, storeId: row.normalized.storeId, sku: row.normalized.sku },
          })
          productId = created.id
        }
        if (row.normalized.stock > 0) {
          await prisma.inventoryBatch.create({
            data: {
              productId,
              storeId: row.normalized.storeId,
              batchNumber: row.normalized.batch || `IMP-${row.rowNumber}`,
              quantity: row.normalized.stock,
              expiry: row.normalized.expiry || '12/30',
            },
          })
        }
        await prisma.stockMovement.create({
          data: {
            productId,
            storeId: row.normalized.storeId,
            quantity: row.normalized.stock,
            reason: 'import',
            note: `Import row ${row.rowNumber}`,
            userId: req.user!.id,
          },
        })
        saved.push(row.rowNumber)
      } catch (error) {
        failed.push({
          rowNumber: row.rowNumber,
          errors: [error instanceof Error ? error.message : 'Could not save row'],
          values: row.values,
        })
      }
    }
    res.json({ saved: saved.length, skipped: skipped.length, failed, imported: saved.length })
  } catch (error) {
    next(error instanceof z.ZodError ? new HttpError(400, 'Import data is not valid') : error)
  }
})
