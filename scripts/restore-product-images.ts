import fs from 'node:fs'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const uploadDir = path.resolve('uploads/products')

const seeded: Record<string, string> = {
  'HER-CAL-090': 'HER-CAL-090.jpg',
  'HER-WMV-060': 'HER-WMV-060.jpg',
  'HER-YAK-020': 'HER-YAK-020.jpg',
  'HER-IMC-060': 'HER-IMC-060.jpg',
  'HER-LOR-030': 'HER-LOR-030.jpg',
  'HER-GLU-050': 'HER-GLU-050.jpg',
}

const fallbackFiles = ['fallback-1.jpg', 'fallback-2.jpg', 'fallback-3.jpg', 'fallback-4.jpg']

async function main() {
  fs.mkdirSync(uploadDir, { recursive: true })
  const products = await prisma.product.findMany({ orderBy: { name: 'asc' } })
  let fallbackIndex = 0
  for (const product of products) {
    const preferred = seeded[product.sku]
    let fileName =
      preferred && fs.existsSync(path.join(uploadDir, preferred)) ? preferred : ''
    if (!fileName) {
      fileName = fallbackFiles[fallbackIndex % fallbackFiles.length]
      fallbackIndex += 1
    }
    if (!fs.existsSync(path.join(uploadDir, fileName))) {
      console.log('missing file', fileName, 'for', product.sku)
      continue
    }
    const imageUrl = `/uploads/products/${fileName}`
    await prisma.product.update({ where: { id: product.id }, data: { imageUrl } })
    console.log(product.sku, '->', imageUrl)
  }
}

main()
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
