import { z } from 'zod'
import { HttpError } from '../lib/http.js'

const phoneRe = /^[+]?[\d\s()-]{8,24}$/

export const deliveryAddressSchema = z.object({
  label: z.string().trim().min(1).max(40).default('Home'),
  recipientName: z.string().trim().min(2, 'Recipient name must be at least 2 characters').max(80),
  phone: z
    .string()
    .trim()
    .min(8)
    .max(24)
    .refine((value) => phoneRe.test(value), 'Enter a valid phone number'),
  houseNo: z.string().trim().min(1).max(40),
  street: z.string().trim().min(2, 'Street must be at least 2 characters').max(120),
  area: z.string().trim().min(2, 'Area must be at least 2 characters').max(80),
  city: z.string().trim().min(2, 'City must be at least 2 characters').max(80),
  landmark: z.string().trim().max(120).optional().default(''),
  deliveryInstructions: z.string().trim().max(240).optional().default(''),
  lat: z.number().min(-90).max(90).nullable().optional(),
  lng: z.number().min(-180).max(180).nullable().optional(),
  isDefault: z.boolean().optional(),
})

/** Loose input for checkout payloads — short fields are normalized before final assert. */
export const checkoutAddressInputSchema = z.object({
  label: z.string().trim().max(40).optional(),
  recipientName: z.string().trim().max(80).optional(),
  phone: z.string().trim().max(24).optional(),
  houseNo: z.string().trim().max(40).optional(),
  street: z.string().trim().max(120).optional(),
  area: z.string().trim().max(80).optional(),
  city: z.string().trim().max(80).optional(),
  landmark: z.string().trim().max(120).optional(),
  deliveryInstructions: z.string().trim().max(240).optional(),
  line: z.string().trim().max(240).optional(),
  lat: z.number().min(-90).max(90).nullable().optional(),
  lng: z.number().min(-180).max(180).nullable().optional(),
  isDefault: z.boolean().optional(),
})

export const pickupContactSchema = z.object({
  recipientName: z.string().trim().min(2).max(80),
  phone: z
    .string()
    .trim()
    .min(8)
    .max(24)
    .refine((value) => phoneRe.test(value), 'Enter a valid phone number'),
})

export type DeliveryAddressInput = z.infer<typeof deliveryAddressSchema>

export function formatAddressLine(input: {
  houseNo?: string
  street?: string
  area?: string
  city?: string
  landmark?: string
  line?: string
}) {
  const parts = [input.houseNo, input.street, input.area, input.city]
    .map((part) => String(part ?? '').trim())
    .filter(Boolean)
  if (parts.length) {
    const base = parts.join(', ')
    const landmark = String(input.landmark ?? '').trim().replace(/^near\s+/i, '')
    return landmark ? `${base} (Near ${landmark})` : base
  }
  return String(input.line ?? '').trim()
}

export function assertDeliveryAddress(input: DeliveryAddressInput) {
  const parsed = deliveryAddressSchema.parse(input)
  const line = formatAddressLine(parsed)
  if (!line) throw new HttpError(400, 'Enter a complete delivery address')
  return { ...parsed, line }
}

/** Match city/area against store deliveryArea text, or allow empty deliveryArea (serves all). */
export function storeCoversArea(
  deliveryArea: string | null | undefined,
  address: { city?: string; area?: string; line?: string },
) {
  const zone = String(deliveryArea ?? '').trim().toLowerCase()
  if (!zone || zone === 'local delivery area' || zone === 'all') return true
  const city = String(address.city ?? '').trim().toLowerCase()
  const area = String(address.area ?? '').trim().toLowerCase()
  const hay = `${city} ${area} ${address.line ?? ''}`.toLowerCase()
  const parts = zone
    .split(/[,;/|]+/)
    .map((part) => part.trim())
    .filter(Boolean)
  if (parts.some((part) => hay.includes(part) || part.includes(city) || (area && part.includes(area)))) {
    return true
  }
  const nycBoroughs = ['manhattan', 'brooklyn', 'queens', 'bronx', 'staten island']
  if ((city.includes('new york') || city === 'nyc') && parts.some((part) => nycBoroughs.includes(part))) {
    return true
  }
  return false
}
