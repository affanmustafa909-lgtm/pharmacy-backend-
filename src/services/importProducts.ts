import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import ExcelJS from 'exceljs'
import { isExpired } from '../lib/expiry.js'
import { prisma } from '../lib/prisma.js'
import { HttpError } from '../lib/http.js'

export const IMPORT_FIELDS = [
  'storeCode',
  'sku',
  'name',
  'brand',
  'genericName',
  'strength',
  'category',
  'unitLabel',
  'price',
  'stock',
  'description',
  'rxRequired',
  'onlineSale',
  'batch',
  'expiry',
  'imageUrl',
] as const

export type ImportField = (typeof IMPORT_FIELDS)[number]

export interface NormalizedProduct {
  storeCode: string
  storeId: string
  sku: string
  name: string
  brand: string
  genericName: string
  strength: string
  category: string
  unitLabel: string
  price: number
  stock: number
  description: string
  rxRequired: boolean
  onlineSale: boolean
  batch: string
  expiry: string
  imageUrl: string
}

export interface PreviewRow {
  rowNumber: number
  values: Record<string, string>
  normalized: NormalizedProduct | null
  errors: string[]
  duplicate: boolean
}

const HEADER_ALIASES: Record<string, ImportField> = {
  storecode: 'storeCode',
  store: 'storeCode',
  sku: 'sku',
  name: 'name',
  product: 'name',
  productname: 'name',
  brand: 'brand',
  genericname: 'genericName',
  generic: 'genericName',
  strength: 'strength',
  category: 'category',
  unitlabel: 'unitLabel',
  pack: 'unitLabel',
  price: 'price',
  productprice: 'price',
  stock: 'stock',
  qty: 'stock',
  quantity: 'stock',
  description: 'description',
  rxrequired: 'rxRequired',
  prescription: 'rxRequired',
  onlinesale: 'onlineSale',
  online: 'onlineSale',
  batch: 'batch',
  expiry: 'expiry',
  expiration: 'expiry',
  imageurl: 'imageUrl',
  image: 'imageUrl',
  photo: 'imageUrl',
  picture: 'imageUrl',
  pic: 'imageUrl',
}

const UPLOAD_DIR = path.resolve('uploads/products')

function cellText(value: ExcelJS.CellValue) {
  if (value == null) return ''
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  if (typeof value === 'object') {
    if ('richText' in value && Array.isArray(value.richText)) {
      return value.richText.map((part) => part.text ?? '').join('').trim()
    }
    if ('text' in value) return String(value.text ?? '').trim()
    if ('result' in value) return cellText(value.result as ExcelJS.CellValue)
    if ('hyperlink' in value) return String((value as { text?: string }).text ?? '').trim()
  }
  return String(value).trim()
}

function ensureUploadDir() {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true })
}

function saveEmbeddedImage(image: ExcelJS.Image) {
  if (!image.buffer) return ''
  ensureUploadDir()
  const extension = image.extension === 'jpeg' ? 'jpg' : image.extension || 'png'
  const filename = `import-${randomUUID()}.${extension}`
  fs.writeFileSync(path.join(UPLOAD_DIR, filename), Buffer.from(image.buffer))
  return `/uploads/products/${filename}`
}

function excelRowFromAnchor(row: number) {
  if (!Number.isFinite(row)) return -1
  return Math.round(row) + 1
}

function extractImagesByExcelRow(workbook: ExcelJS.Workbook, sheet: ExcelJS.Worksheet) {
  const byRow = new Map<number, string>()
  for (const drawing of sheet.getImages()) {
    const excelRow = excelRowFromAnchor(Number(drawing.range.tl.row))
    if (excelRow < 2 || byRow.has(excelRow)) continue
    const imageId = Number(drawing.imageId)
    if (!Number.isFinite(imageId)) continue
    try {
      const image = workbook.getImage(imageId)
      const saved = saveEmbeddedImage(image)
      if (saved) byRow.set(excelRow, saved)
    } catch {
      // Skip unreadable drawings and keep importing row text.
    }
  }
  return byRow
}

export function suggestMap(headers: string[]): Record<ImportField, string> {
  const map = Object.fromEntries(IMPORT_FIELDS.map((field) => [field, ''])) as Record<ImportField, string>
  headers.forEach((header) => {
    const key = header.toLowerCase().replace(/[^a-z0-9]/g, '')
    const field = HEADER_ALIASES[key]
    if (field && !map[field]) map[field] = header
  })
  return map
}

function truthy(value: string) {
  return ['1', 'true', 'yes', 'y'].includes(value.trim().toLowerCase())
}

function parsePrice(value: string) {
  const cleaned = value.replace(/[^0-9.-]/g, '')
  const price = Number(cleaned)
  return price
}

function parseStock(value: string) {
  if (!value.trim()) return 0
  const stock = Number(value.replace(/[^0-9.-]/g, ''))
  if (!Number.isFinite(stock) || stock < 0) return Number.NaN
  return Math.round(stock)
}

function slugSku(name: string, rowNumber: number) {
  const base = name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 18)
  return `IMP-${base || 'ITEM'}-${rowNumber}`
}

export async function previewRows(
  headers: string[],
  rawRows: string[][],
  map: Record<ImportField, string>,
  allowedStoreId: string | null,
  embeddedImageUrls: string[] = [],
  forcedStoreId: string | null = null,
): Promise<PreviewRow[]> {
  const stores = await prisma.store.findMany()
  const byCode = new Map(stores.map((store) => [store.code.toLowerCase(), store]))
  const byId = new Map(stores.map((store) => [store.id, store]))
  const forcedStore = forcedStoreId ? byId.get(forcedStoreId) ?? null : null
  const existing = await prisma.product.findMany({ select: { storeId: true, sku: true } })
  const existingKeys = new Set(existing.map((item) => `${item.storeId}:${item.sku.toLowerCase()}`))
  const seen = new Set<string>()
  let lastStoreCode = forcedStore?.code ?? ''

  return rawRows.map((raw, index) => {
    const values: Record<string, string> = {}
    headers.forEach((header, headerIndex) => {
      values[header] = raw[headerIndex] ?? ''
    })
    const read = (field: ImportField) => values[map[field]]?.trim() ?? ''
    const errors: string[] = []
    const rawStoreCode = read('storeCode')
    const storeCode = rawStoreCode || lastStoreCode || forcedStore?.code || ''
    if (storeCode) lastStoreCode = storeCode
    const name = read('name')
    const sku = read('sku') || (name ? slugSku(name, index + 2) : '')
    const price = parsePrice(read('price'))
    const stock = parseStock(read('stock'))
    const matchedByCode = storeCode ? byCode.get(storeCode.toLowerCase()) : undefined
    const store = matchedByCode || (!rawStoreCode && forcedStore ? forcedStore : undefined)
    const imageUrl = read('imageUrl') || embeddedImageUrls[index] || ''
    if (!storeCode && !forcedStore) errors.push('Store code is required')
    else if (rawStoreCode && !matchedByCode) errors.push(`Unknown store code ${rawStoreCode}`)
    else if (!store) errors.push(`Unknown store code ${storeCode}`)
    else if (allowedStoreId && store.id !== allowedStoreId) errors.push('You cannot import products for another store')
    else if (forcedStoreId && store.id !== forcedStoreId) {
      errors.push(`Row store ${store.code} does not match the selected branch ${forcedStore?.code ?? ''}`)
    }
    if (!sku) errors.push('SKU is required')
    if (!name) errors.push('Name is required')
    if (!Number.isFinite(price) || price < 0) errors.push('Price must be zero or more')
    if (!Number.isFinite(stock)) errors.push('Stock must be a whole number')
    const expiry = read('expiry')
    if (expiry && isExpired(expiry)) errors.push('Expiry date is in the past')
    let duplicate = false
    if (store && sku) {
      const key = `${store.id}:${sku.toLowerCase()}`
      duplicate = existingKeys.has(key) || seen.has(key)
      seen.add(key)
    }
    const normalized =
      errors.length === 0 && store
        ? {
            storeCode: store.code,
            storeId: store.id,
            sku,
            name,
            brand: read('brand') || 'hera.',
            genericName: read('genericName'),
            strength: read('strength'),
            category: read('category') || 'Medicines',
            unitLabel: read('unitLabel') || '1 unit',
            price,
            stock,
            description: read('description'),
            rxRequired: truthy(read('rxRequired')),
            onlineSale: read('onlineSale') === '' ? true : truthy(read('onlineSale')),
            batch: read('batch'),
            expiry,
            imageUrl,
          }
        : null
    return {
      rowNumber: index + 2,
      values: { ...values, sku, storeCode, imageUrl },
      normalized,
      errors,
      duplicate,
    }
  })
}

export async function workbookFromUpload(buffer: Buffer) {
  if (!buffer?.length) throw new HttpError(400, 'File is empty')
  const workbook = new ExcelJS.Workbook()
  try {
    await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer)
  } catch {
    throw new HttpError(400, 'Could not read that file. Save it as .xlsx and try again.')
  }
  const sheet = workbook.worksheets[0]
  if (!sheet) throw new HttpError(400, 'The workbook has no sheets')

  const headerEntries: { col: number; name: string }[] = []
  const headerRow = sheet.getRow(1)
  headerRow.eachCell({ includeEmpty: false }, (cell, col) => {
    const name = cellText(cell.value)
    if (name) headerEntries.push({ col, name })
  })
  if (headerEntries.length === 0) throw new HttpError(400, 'The first row must contain column names')

  const headers = headerEntries.map((entry) => entry.name)
  const imagesByRow = extractImagesByExcelRow(workbook, sheet)
  const rows: string[][] = []
  const embeddedImageUrls: string[] = []
  const excelRows: number[] = []

  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return
    const values = headerEntries.map(({ col }) => cellText(row.getCell(col).value))
    if (values.every((value) => value === '')) return
    rows.push(values)
    excelRows.push(rowNumber)
    embeddedImageUrls.push(imagesByRow.get(rowNumber) ?? '')
  })

  // Catch image-only rows that ExcelJS may skip when text cells are empty.
  for (const [excelRow, imageUrl] of imagesByRow) {
    if (excelRow < 2 || excelRows.includes(excelRow)) continue
    const row = sheet.getRow(excelRow)
    const values = headerEntries.map(({ col }) => cellText(row.getCell(col).value))
    if (values.every((value) => value === '') && !imageUrl) continue
    rows.push(values)
    excelRows.push(excelRow)
    embeddedImageUrls.push(imageUrl)
  }

  if (rows.length === 0) throw new HttpError(400, 'No product rows found under the header')
  if (rows.length > 1000) throw new HttpError(400, 'Import up to 1000 rows at a time')
  return { headers, rows, embeddedImageUrls }
}

export async function templateBuffer() {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Products')
  sheet.addRow([...IMPORT_FIELDS])
  sheet.addRow(['ALI', 'HER-NEW-001', 'Example Medicine', 'hera.', 'Ibuprofen', '200mg', 'Medicines', '20 tablets', 12.5, 30, 'Short description', 'no', 'yes', 'EX-26', '12/27', ''])
  sheet.addRow(['ALI', 'HER-NEW-002', 'Vitamin D3', 'hera.', 'Cholecalciferol', '1000 IU', 'Vitamins', '60 softgels', 18, 40, 'Daily vitamin D', 'no', 'yes', 'VD-26', '06/27', ''])
  sheet.addRow(['ALI', 'HER-NEW-003', 'Cough Syrup', 'hera.', 'Dextromethorphan', '15mg/5ml', 'Medicines', '120 ml', 9.5, 25, 'Sugar free syrup', 'no', 'yes', 'CS-26', '03/27', ''])
  sheet.getRow(1).font = { bold: true }
  sheet.columns.forEach((column) => {
    column.width = 18
  })
  const data = await workbook.xlsx.writeBuffer()
  return Buffer.from(data)
}
