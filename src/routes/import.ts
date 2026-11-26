import { Router } from 'express'
import multer from 'multer'
import { z } from 'zod'
import { HttpError } from '../lib/http.js'
import { prisma } from '../lib/prisma.js'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { dec } from '../services/money.js'
import { assertStoreAccess, accessibleStoreIds } from '../services/permissions.js'
import {
  IMPORT_FIELDS,
  failedRowsBuffer,
  previewRows,
  suggestMap,
  templateBuffer,
  workbookFromUpload,
  type ImportField,
} from '../services/importProducts.js'
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

    // Nothing valid in the file => block the import, save nothing.
    if (rows.filter((row) => row.errors.length === 0).length === 0) {
      res.json({
        saved: 0,
        skipped: 0,
        failed,
        imported: 0,
        total: rows.length,
        blocked: true,
        message: 'No valid rows to import. Fix the errors and upload again.',
      })
      return
    }

    for (const row of rows) {
      if (!row.normalized || row.errors.length > 0) continue
      const n = row.normalized
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
        await assertStoreAccess(req.user!, n.storeId, { roles: ['OWNER', 'STORE_MANAGER'] })
        const data = {
          name: n.name,
          brand: n.brand,
          genericName: n.genericName,
          strength: n.strength,
          category: n.category,
          unitLabel: n.unitLabel,
          price: dec(n.price),
          stock: n.stock,
          description: n.description,
          rxRequired: n.rxRequired,
          onlineSale: n.onlineSale,
          batch: n.batch,
          expiry: n.expiry,
          imageUrl: n.imageUrl,
        }
        // One row = one transaction: product, batch and history are saved together or not at all.
        await prisma.$transaction(
          async (tx) => {
            let productId = ''
            let previousStock = 0
            const old =
              row.duplicate && body.duplicateStrategy === 'update'
                ? await tx.product.findUnique({
                    where: { storeId_sku: { storeId: n.storeId, sku: n.sku } },
                    select: { id: true, stock: true },
                  })
                : null
            if (old) {
              await tx.product.update({ where: { id: old.id }, data })
              productId = old.id
              previousStock = old.stock
              await tx.inventoryBatch.deleteMany({ where: { productId } })
            } else {
              const created = await tx.product.create({ data: { ...data, storeId: n.storeId, sku: n.sku } })
              productId = created.id
            }
            if (n.stock > 0) {
              await tx.inventoryBatch.create({
                data: {
                  productId,
                  storeId: n.storeId,
                  batchNumber: n.batch || `IMP-${row.rowNumber}`,
                  quantity: n.stock,
                  expiry: n.expiry,
                },
              })
            }
            // History records only the CHANGE (new stock minus old stock).
            const delta = n.stock - previousStock
            if (delta !== 0) {
              await tx.stockMovement.create({
                data: {
                  productId,
                  storeId: n.storeId,
                  quantity: delta,
                  reason: 'import',
                  note: `Import row ${row.rowNumber}`,
                  userId: req.user!.id,
                },
              })
            }
          },
          { maxWait: 10000, timeout: 30000 },
        )
        saved.push(row.rowNumber)
      } catch (error) {
        failed.push({
          rowNumber: row.rowNumber,
          errors: [error instanceof Error ? error.message : 'Could not save row'],
          values: row.values,
        })
      }
    }

    if (saved.length > 0) {
      await prisma.auditLog
        .create({
          data: {
            actorId: req.user!.id,
            storeId: forcedStoreId,
            action: 'product.import',
            detail: `${saved.length} saved, ${skipped.length} skipped, ${failed.length} failed`,
            meta: { strategy: body.duplicateStrategy, total: rows.length },
          },
        })
        .catch(() => undefined)
    }

    res.json({
      saved: saved.length,
      skipped: skipped.length,
      failed,
      imported: saved.length,
      total: rows.length,
      blocked: false,
    })
  } catch (error) {
    next(error instanceof z.ZodError ? new HttpError(400, 'Import data is not valid') : error)
  }
})

// Download the failed rows as an Excel file (send the "failed" list from the commit result).
importRouter.post('/failed-export', async (req, res, next) => {
  try {
    const body = z
      .object({
        failed: z
          .array(
            z.object({
              rowNumber: z.number(),
              errors: z.array(z.string()),
              values: z.record(z.string(), z.string()).optional(),
            }),
          )
          .min(1, 'No failed rows to export')
          .max(1000),
      })
      .parse(req.body)
    const file = await failedRowsBuffer(body.failed)
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', 'attachment; filename="failed-rows.xlsx"')
    res.send(file)
  } catch (error) {
    next(error instanceof z.ZodError ? new HttpError(400, error.issues[0]?.message || 'Check the values') : error)
  }
})