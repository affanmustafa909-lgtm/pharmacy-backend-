import { Router } from 'express'
import { z } from 'zod'
import { HttpError } from '../lib/http.js'
import { prisma } from '../lib/prisma.js'
import { requireAuth, requireRole } from '../middleware/auth.js'
import {
  formatAddressLine as formatStructuredLine,
  geocodeStructuredAddress,
  reverseGeocode,
  searchPlaces,
} from '../services/geocode.js'
import { formatAddressLine as formatCustomerLine } from '../services/deliveryAddress.js'

const addressInput = z.object({
  label: z.string().trim().min(1).max(40),
  line: z.string().trim().max(240).optional(),
  recipientName: z.string().trim().max(80).optional(),
  houseNo: z.string().trim().max(40).optional(),
  street: z.string().trim().max(120).optional(),
  area: z.string().trim().max(80).optional(),
  subCity: z.string().trim().max(80).optional(),
  city: z.string().trim().max(80).optional(),
  state: z.string().trim().max(80).optional(),
  country: z.string().trim().max(80).optional(),
  postalCode: z.string().trim().max(24).optional(),
  landmark: z.string().trim().max(120).optional(),
  phone: z.string().trim().max(32).optional(),
  deliveryInstructions: z.string().trim().max(240).optional(),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
  lat: z.number().min(-90).max(90).nullable().optional(),
  lng: z.number().min(-180).max(180).nullable().optional(),
  isDefault: z.boolean().optional(),
})

type AddressRow = {
  id: string
  label: string
  line: string
  recipientName: string
  houseNo: string
  street: string
  subCity: string
  city: string
  state: string
  country: string
  postalCode: string
  landmark: string
  phone: string
  deliveryInstructions: string
  latitude: number | null
  longitude: number | null
  isDefault: boolean
}

function mapAddress(item: AddressRow) {
  return {
    id: item.id,
    label: item.label,
    line: item.line,
    recipientName: item.recipientName,
    houseNo: item.houseNo,
    street: item.street,
    area: item.subCity,
    subCity: item.subCity,
    city: item.city,
    state: item.state,
    country: item.country,
    postalCode: item.postalCode,
    landmark: item.landmark,
    phone: item.phone,
    deliveryInstructions: item.deliveryInstructions,
    latitude: item.latitude,
    longitude: item.longitude,
    lat: item.latitude,
    lng: item.longitude,
    isDefault: item.isDefault,
  }
}

function resolveCoords(body: z.infer<typeof addressInput>) {
  const latitude = body.latitude ?? body.lat ?? null
  const longitude = body.longitude ?? body.lng ?? null
  return { latitude, longitude }
}

/** When the pin is inside Karachi metro, keep city usable for delivery-area matching. */
function normalizeCityForPin(city: string, latitude: number | null, longitude: number | null) {
  if (latitude == null || longitude == null) return city
  const inKarachi = latitude >= 24.7 && latitude <= 25.2 && longitude >= 66.8 && longitude <= 67.4
  if (!inKarachi) return city
  const trimmed = city.trim()
  if (!trimmed || trimmed.length < 3 || !/karachi/i.test(trimmed)) {
    return 'Karachi'
  }
  return city
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
    let { latitude, longitude } = resolveCoords(body)

    if ((latitude == null) !== (longitude == null)) {
      throw new HttpError(400, 'Latitude and longitude must be provided together')
    }

    const recipientName = body.recipientName ?? ''
    const houseNo = body.houseNo ?? ''
    let street = body.street ?? ''
    let subCity = body.area ?? body.subCity ?? ''
    let city = body.city ?? ''
    let state = body.state ?? ''
    let country = body.country ?? ''
    let postalCode = body.postalCode ?? ''
    const landmark = body.landmark ?? ''
    const phone = body.phone ?? ''
    const deliveryInstructions = body.deliveryInstructions ?? ''
    city = normalizeCityForPin(city, latitude, longitude)
    if (city === 'Karachi' && !country.trim()) country = 'Pakistan'

    const composedLine =
      formatCustomerLine({
        houseNo,
        street,
        area: subCity,
        city,
        landmark,
        line: body.line,
      }) ||
      formatStructuredLine({
        street,
        subCity,
        city,
        state,
        postalCode,
        country,
        fallback: body.line,
      })

    if (!composedLine) {
      throw new HttpError(400, 'Enter a street, area, city, or full address')
    }

    if (latitude == null || longitude == null) {
      const geocoded = await geocodeStructuredAddress({
        street: [houseNo, street].filter(Boolean).join(' '),
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
        // Only fill blank structured fields for routing — never overwrite user text.
        if (!street) street = geocoded.street
        if (!subCity) subCity = geocoded.subCity
        if (!city) city = geocoded.city
        if (!state) state = geocoded.state
        if (!country) country = geocoded.country
        if (!postalCode) postalCode = geocoded.postalCode
      }
    } else if (!houseNo && !street && !subCity && !city) {
      // Pin-only save with no typed address: reverse-geocode for English labels.
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
      formatCustomerLine({
        houseNo,
        street,
        area: subCity,
        city,
        landmark,
        line: composedLine,
      }) || composedLine

    const count = await prisma.customerAddress.count({
      where: { customerId: req.user!.id },
    })

    const created = await prisma.customerAddress.create({
      data: {
        customerId: req.user!.id,
        label: body.label,
        line: finalLine,
        recipientName,
        houseNo,
        street,
        subCity,
        city,
        state,
        country,
        postalCode,
        landmark,
        phone,
        deliveryInstructions,
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
    const existing = await prisma.customerAddress.findUnique({
      where: { id: req.params.id },
    })

    if (!existing || existing.customerId !== req.user!.id) {
      throw new HttpError(404, 'Address not found')
    }

    const coordsProvided = body.latitude !== undefined || body.lat !== undefined || body.longitude !== undefined || body.lng !== undefined
    let latitude = existing.latitude
    let longitude = existing.longitude
    if (coordsProvided) {
      const next = resolveCoords({
        ...body,
        label: body.label ?? existing.label,
      } as z.infer<typeof addressInput>)
      if ((next.latitude == null) !== (next.longitude == null)) {
        throw new HttpError(400, 'Latitude and longitude must be updated together')
      }
      latitude = next.latitude
      longitude = next.longitude
    }

    const recipientName = body.recipientName !== undefined ? body.recipientName : existing.recipientName
    const houseNo = body.houseNo !== undefined ? body.houseNo : existing.houseNo
    const street = body.street !== undefined ? body.street : existing.street
    const subCity =
      body.area !== undefined ? body.area : body.subCity !== undefined ? body.subCity : existing.subCity
    let city = body.city !== undefined ? body.city : existing.city
    const state = body.state !== undefined ? body.state : existing.state
    let country = body.country !== undefined ? body.country : existing.country
    const postalCode = body.postalCode !== undefined ? body.postalCode : existing.postalCode
    const landmark = body.landmark !== undefined ? body.landmark : existing.landmark
    const phone = body.phone !== undefined ? body.phone : existing.phone
    const deliveryInstructions =
      body.deliveryInstructions !== undefined ? body.deliveryInstructions : existing.deliveryInstructions
    city = normalizeCityForPin(city, latitude, longitude)
    if (city === 'Karachi' && !String(country).trim()) country = 'Pakistan'

    const addressFieldsChanged =
      body.street !== undefined ||
      body.area !== undefined ||
      body.subCity !== undefined ||
      body.city !== undefined ||
      body.state !== undefined ||
      body.country !== undefined ||
      body.postalCode !== undefined ||
      body.houseNo !== undefined ||
      body.line !== undefined

    const finalLine =
      formatCustomerLine({
        houseNo,
        street,
        area: subCity,
        city,
        landmark,
        line: body.line !== undefined ? body.line : existing.line,
      }) || existing.line

    if (addressFieldsChanged && !coordsProvided) {
      const geocoded = await geocodeStructuredAddress({
        street: [houseNo, street].filter(Boolean).join(' '),
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
        recipientName,
        houseNo,
        street,
        subCity,
        city,
        state,
        country,
        postalCode,
        landmark,
        phone,
        deliveryInstructions,
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

    if (existing.isDefault) {
      const nextDefault = await prisma.customerAddress.findFirst({
        where: { customerId: req.user!.id },
        orderBy: { label: 'asc' },
      })
      if (nextDefault) {
        await prisma.customerAddress.update({
          where: { id: nextDefault.id },
          data: { isDefault: true },
        })
      }
    }

    res.status(204).end()
  } catch (error) {
    next(error)
  }
})
