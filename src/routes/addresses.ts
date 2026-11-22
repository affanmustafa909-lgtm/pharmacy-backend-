import { Router } from 'express'
import { z } from 'zod'
import { HttpError } from '../lib/http.js'
import { prisma } from '../lib/prisma.js'
import { requireAuth, requireRole } from '../middleware/auth.js'
import {
  formatAddressLine,
  geocodeStructuredAddress,
  reverseGeocode,
  searchPlaces,
} from '../services/geocode.js'

const addressInput = z.object({
  label: z.string().trim().min(1).max(40),
  line: z.string().trim().max(240).optional(),
  street: z.string().trim().max(120).optional(),
  subCity: z.string().trim().max(80).optional(),
  city: z.string().trim().max(80).optional(),
  state: z.string().trim().max(80).optional(),
  country: z.string().trim().max(80).optional(),
  postalCode: z.string().trim().max(24).optional(),
  landmark: z.string().trim().max(120).optional(),
  phone: z.string().trim().max(32).optional(),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
  isDefault: z.boolean().optional(),
})

function mapAddress(item: {
  id: string
  label: string
  line: string
  street: string
  subCity: string
  city: string
  state: string
  country: string
  postalCode: string
  landmark: string
  phone: string
  latitude: number | null
  longitude: number | null
  isDefault: boolean
}) {
  return {
    id: item.id,
    label: item.label,
    line: item.line,
    street: item.street,
    subCity: item.subCity,
    city: item.city,
    state: item.state,
    country: item.country,
    postalCode: item.postalCode,
    landmark: item.landmark,
    phone: item.phone,
    latitude: item.latitude,
    longitude: item.longitude,
    isDefault: item.isDefault,
  }
}

export const addressRouter = Router()
addressRouter.use(requireAuth, requireRole('CUSTOMER'))

addressRouter.get('/search', async (req, res, next) => {
  try {
    const q = String(req.query.q ?? '').trim()
    if (q.length < 2) {
      res.json({ places: [] })
      return
    }
    const places = await searchPlaces(q, 6)
    res.json({ places })
  } catch (error) {
    next(error)
  }
})

addressRouter.get('/reverse', async (req, res, next) => {
  try {
    const lat = Number(req.query.lat)
    const lng = Number(req.query.lng)
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      throw new HttpError(400, 'Valid latitude and longitude are required')
    }
    const place = await reverseGeocode(lat, lng)
    res.json({ place })
  } catch (error) {
    next(error)
  }
})

addressRouter.get('/mine', async (req, res) => {
  const addresses = await prisma.customerAddress.findMany({
    where: { customerId: req.user!.id },
    orderBy: [{ isDefault: 'desc' }, { label: 'asc' }],
  })
  res.json({
    addresses: addresses.map(mapAddress),
  })
})

addressRouter.post('/', async (req, res, next) => {
  try {
    const body = addressInput.parse(req.body)

    if ((body.latitude == null) !== (body.longitude == null)) {
      throw new HttpError(400, 'Latitude and longitude must be provided together')
    }

    let latitude = body.latitude ?? null
    let longitude = body.longitude ?? null
    let street = body.street ?? ''
    let subCity = body.subCity ?? ''
    let city = body.city ?? ''
    let state = body.state ?? ''
    let country = body.country ?? ''
    let postalCode = body.postalCode ?? ''

    const composedLine = formatAddressLine({
      street,
      subCity,
      city,
      state,
      postalCode,
      country,
      fallback: body.line,
    })

    if (!composedLine) {
      throw new HttpError(400, 'Enter a street, sub-city, city, or full address')
    }

    // Auto-geocode coordinates when missing so distance-based delivery pricing works seamlessly.
    if (latitude == null || longitude == null) {
      const geocoded = await geocodeStructuredAddress({
        street,
        subCity,
        city,
        state,
        postalCode,
        country,
        line: composedLine,
      })
      if (geocoded) {
        latitude = geocoded.latitude
        longitude = geocoded.longitude
        if (!street) street = geocoded.street
        if (!subCity) subCity = geocoded.subCity
        if (!city) city = geocoded.city
        if (!state) state = geocoded.state
        if (!country) country = geocoded.country
        if (!postalCode) postalCode = geocoded.postalCode
      }
    } else if (!country && !city) {
      // Backfill structured fields from GPS coordinates if user only provided lat/lng + raw line
      const reversed = await reverseGeocode(latitude, longitude)
      if (reversed) {
        if (!street) street = reversed.street
        if (!subCity) subCity = reversed.subCity
        if (!city) city = reversed.city
        if (!state) state = reversed.state
        if (!country) country = reversed.country
        if (!postalCode) postalCode = reversed.postalCode
      }
    }

    const finalLine =
      formatAddressLine({
        street,
        subCity,
        city,
        state,
        postalCode,
        country,
        fallback: composedLine,
      }) || composedLine

    const count = await prisma.customerAddress.count({
      where: { customerId: req.user!.id },
    })

    const created = await prisma.customerAddress.create({
      data: {
        customerId: req.user!.id,
        label: body.label,
        line: finalLine,
        street,
        subCity,
        city,
        state,
        country,
        postalCode,
        landmark: body.landmark ?? '',
        phone: body.phone ?? '',
        latitude,
        longitude,
        isDefault: body.isDefault ?? count === 0,
      },
    })

    if (created.isDefault) {
      await prisma.customerAddress.updateMany({
        where: { customerId: req.user!.id, NOT: { id: created.id } },
        data: { isDefault: false },
      })
    }

    res.status(201).json(mapAddress(created))
  } catch (error) {
    next(error instanceof z.ZodError ? new HttpError(400, 'Check the address') : error)
  }
})

addressRouter.patch('/:id', async (req, res, next) => {
  try {
    const body = addressInput.partial().parse(req.body)

    if (
      (body.latitude !== undefined && body.longitude === undefined) ||
      (body.longitude !== undefined && body.latitude === undefined) ||
      (body.latitude === null && body.longitude !== null) ||
      (body.longitude === null && body.latitude !== null)
    ) {
      throw new HttpError(400, 'Latitude and longitude must be updated together')
    }

    const existing = await prisma.customerAddress.findUnique({
      where: { id: req.params.id },
    })

    if (!existing || existing.customerId !== req.user!.id) {
      throw new HttpError(404, 'Address not found')
    }

    const street = body.street !== undefined ? body.street : existing.street
    const subCity = body.subCity !== undefined ? body.subCity : existing.subCity
    const city = body.city !== undefined ? body.city : existing.city
    const state = body.state !== undefined ? body.state : existing.state
    const country = body.country !== undefined ? body.country : existing.country
    const postalCode = body.postalCode !== undefined ? body.postalCode : existing.postalCode
    const landmark = body.landmark !== undefined ? body.landmark : existing.landmark
    const phone = body.phone !== undefined ? body.phone : existing.phone

    const addressFieldsChanged =
      body.street !== undefined ||
      body.subCity !== undefined ||
      body.city !== undefined ||
      body.state !== undefined ||
      body.country !== undefined ||
      body.postalCode !== undefined ||
      body.line !== undefined

    let latitude = body.latitude !== undefined ? body.latitude : existing.latitude
    let longitude = body.longitude !== undefined ? body.longitude : existing.longitude

    const finalLine = formatAddressLine({
      street,
      subCity,
      city,
      state,
      postalCode,
      country,
      fallback: body.line !== undefined ? body.line : existing.line,
    })

    if (addressFieldsChanged && body.latitude === undefined && body.longitude === undefined) {
      const geocoded = await geocodeStructuredAddress({
        street,
        subCity,
        city,
        state,
        postalCode,
        country,
        line: finalLine,
      })
      if (geocoded) {
        latitude = geocoded.latitude
        longitude = geocoded.longitude
      }
    }

    const updated = await prisma.customerAddress.update({
      where: { id: existing.id },
      data: {
        label: body.label,
        line: finalLine,
        street,
        subCity,
        city,
        state,
        country,
        postalCode,
        landmark,
        phone,
        latitude,
        longitude,
        isDefault: body.isDefault,
      },
    })

    if (updated.isDefault) {
      await prisma.customerAddress.updateMany({
        where: { customerId: req.user!.id, NOT: { id: updated.id } },
        data: { isDefault: false },
      })
    }

    res.json(mapAddress(updated))
  } catch (error) {
    next(error instanceof z.ZodError ? new HttpError(400, 'Check the address') : error)
  }
})

addressRouter.delete('/:id', async (req, res, next) => {
  try {
    const existing = await prisma.customerAddress.findUnique({
      where: { id: req.params.id },
    })

    if (!existing || existing.customerId !== req.user!.id) {
      throw new HttpError(404, 'Address not found')
    }

    await prisma.customerAddress.delete({ where: { id: existing.id } })
    res.status(204).end()
  } catch (error) {
    next(error)
  }
})
