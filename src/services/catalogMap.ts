import type { Product, Store } from '@prisma/client'
import { isExpired } from '../lib/expiry.js'
import { money } from './money.js'

export function mapCatalogProduct(product: Product & { store?: Store | null }) {
  const expired = isExpired(product.expiry)
  return {
    id: product.id,
    storeId: product.storeId,
    storeName: product.store?.name ?? '',
    sku: product.sku,
    name: product.name,
    brand: product.brand,
    genericName: product.genericName,
    strength: product.strength,
    price: money(product.price),
    unitLabel: product.unitLabel,
    description: product.description,
    category: product.category,
    imageUrl: product.imageUrl,
    batch: product.batch,
    expiry: product.expiry,
    expired,
    published: product.published,
    inStock: product.published && product.stock > 0 && !expired,
    outOfStock: product.stock <= 0 || expired,
    stock: product.stock,
    rxRequired: product.rxRequired,
  }
}

export function isSellable(product: Product) {
  return product.published && !product.held && product.onlineSale && product.stock > 0 && !isExpired(product.expiry)
}
