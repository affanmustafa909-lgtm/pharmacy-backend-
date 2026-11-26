import { Router } from 'express'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import multer from 'multer'
import { z } from 'zod'
import { checkPassword, hashPassword, signToken } from '../lib/auth.js'
import { HttpError } from '../lib/http.js'
import { prisma } from '../lib/prisma.js'
import { requireAuth } from '../middleware/auth.js'
import { formatAddressLine, geocodeStructuredAddress } from '../services/geocode.js'
import { loadStoreAccess, writeAudit } from '../services/permissions.js'

const profilePhotoDir = path.resolve('uploads/profiles')
fs.mkdirSync(profilePhotoDir, { recursive: true })

const profilePhotoUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, profilePhotoDir),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase()
      const safeExt = /^\.(jpg|jpeg|png|webp|heic|heif)$/i.test(ext) ? ext : '.jpg'
      cb(null, `profile-${Date.now()}-${Math.random().toString(36).slice(2, 10)}${safeExt}`)
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new HttpError(400, 'Please select an image file'))
    }
    cb(null, true)
  },
})

const riderDocDir = path.resolve('uploads/riders')
fs.mkdirSync(riderDocDir, { recursive: true })

const riderDocUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, riderDocDir),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase() || '.jpg'
      const safe = file.fieldname.replace(/[^a-z]/gi, '').toLowerCase() || 'doc'
      cb(null, `rider-${safe}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`)
    },
  }),
  limits: { fileSize: 6 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith('image/') && file.mimetype !== 'application/pdf') {
      return cb(new HttpError(400, 'Upload an image or PDF document'))
    }
    return cb(null, true)
  },
})

const loginAttempts = new Map<string, { count: number; resetAt: number }>()

function limit(key: string) {
  const now = Date.now()
  const current = loginAttempts.get(key)
  if (!current || current.resetAt < now) {
    loginAttempts.set(key, { count: 1, resetAt: now + 15 * 60 * 1000 })
    return
  }
  current.count += 1
  if (current.count > 20) throw new HttpError(429, 'Too many sign-in attempts. Try again later.')
}

const profileUpdateSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(100).optional(),
  email: z.string().trim().email('Enter a valid email address').max(160).optional(),
  phone: z.string().trim().max(40).optional(),
  city: z.string().trim().max(80).optional(),
  dateOfBirth: z.string().trim().max(30).optional(),
  gender: z.string().trim().max(30).optional(),
  allergies: z.string().trim().max(300).optional(),
})

async function buildUserPayload(user: {
  id: string
  name: string
  email: string
  phone: string
  city: string
  dateOfBirth: string
  gender: string
  allergies: string
  profilePhoto: string | null
  role: 'ADMIN' | 'STAFF' | 'CUSTOMER' | 'RIDER'
  storeId: string | null
  deskRole: 'OWNER' | 'STORE_MANAGER' | 'PHARMACIST' | 'ORDER_STAFF'
  canChangePrice: boolean
  canRefund: boolean
}) {
  const access =
    user.role === 'RIDER'
      ? []
      : await loadStoreAccess({
          id: user.id,
          role: user.role,
          storeId: user.storeId,
          email: user.email,
          name: user.name,
        })
  const assignedStoreIds = access.map((item) => item.storeId)
  const primaryStoreId =
    user.role === 'RIDER'
      ? user.storeId
      : assignedStoreIds.length === 1
        ? assignedStoreIds[0]
        : user.storeId ?? assignedStoreIds[0] ?? null
  const authUser = {
    id: user.id,
    role: user.role,
    storeId: primaryStoreId,
    email: user.email,
    name: user.name,
  }
  return {
    token: signToken(authUser),
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      city: user.city,
      dateOfBirth: user.dateOfBirth,
      gender: user.gender,
      allergies: user.allergies,
      profilePhoto: user.profilePhoto,
      role: user.role,
      storeId: primaryStoreId,
      deskRole: user.role === 'ADMIN' ? 'OWNER' : user.deskRole,
      assignedStoreIds,
      canChangePrice: user.role === 'ADMIN' ? true : user.canChangePrice,
      canRefund: user.role === 'ADMIN' ? true : user.canRefund,
    },
  }
}

const registerSchema = z.object({
  name: z.string().trim().min(1, 'Full name is required').max(100),
  email: z.string().trim().email('Enter a valid email address').max(160),
  password: z.string().min(8, 'Password must be at least 8 characters').max(120),
  phone: z.string().trim().max(40).optional(),
  city: z.string().trim().max(80).optional(),
  dateOfBirth: z.string().trim().max(30).optional(),
  gender: z.string().trim().max(30).optional(),
  allergies: z.string().trim().max(300).optional(),
  street: z.string().trim().max(120).optional(),
  subCity: z.string().trim().max(80).optional(),
  state: z.string().trim().max(80).optional(),
  country: z.string().trim().max(80).optional(),
  postalCode: z.string().trim().max(24).optional(),
})

export const authRouter = Router()

authRouter.post('/register', async (req, res, next) => {
  try {
    const body = registerSchema.parse(req.body)
    const email = body.email.toLowerCase()
    limit(`register:${email}`)

    const existing = await prisma.user.findUnique({ where: { email } })
    if (existing) {
      throw new HttpError(409, 'An account with this email already exists. Please sign in.')
    }

    const passwordHash = await hashPassword(body.password)

    const user = await prisma.user.create({
      data: {
        name: body.name,
        email,
        passwordHash,
        phone: body.phone ?? '',
        city: body.city ?? '',
        dateOfBirth: body.dateOfBirth ?? '',
        gender: body.gender ?? '',
        allergies: body.allergies ?? '',
        role: 'CUSTOMER',
      },
    })

    await writeAudit({
      actorId: user.id,
      action: 'customer.registered',
      detail: 'Customer created an account',
      meta: { source: 'mobile_app' },
    }).catch(() => undefined)
    // Create an initial message thread so staff can message the customer from Admin Panel
    await prisma.messageThread.create({
      data: {
        customerId: user.id,
        online: true,
        unread: 0,
      },
    }).catch(() => undefined)

    // If address / city details were supplied during sign up, save a default delivery address
    const hasAddressParts = Boolean(
      body.street?.trim() || body.subCity?.trim() || body.city?.trim() || body.country?.trim(),
    )
    if (hasAddressParts) {
      const street = body.street?.trim() || ''
      const subCity = body.subCity?.trim() || ''
      const city = body.city?.trim() || ''
      const state = body.state?.trim() || ''
      const country = body.country?.trim() || ''
      const postalCode = body.postalCode?.trim() || ''
      const line = formatAddressLine({ street, subCity, city, state, postalCode, country })
      if (line) {
        const geocoded = await geocodeStructuredAddress({
          street,
          subCity,
          city,
          state,
          postalCode,
          country,
          line,
        }).catch(() => null)
        await prisma.customerAddress.create({
          data: {
            customerId: user.id,
            label: 'Home',
            line,
            street: street || geocoded?.street || '',
            subCity: subCity || geocoded?.subCity || '',
            city: city || geocoded?.city || '',
            state: state || geocoded?.state || '',
            country: country || geocoded?.country || '',
            postalCode: postalCode || geocoded?.postalCode || '',
            latitude: geocoded?.latitude ?? null,
            longitude: geocoded?.longitude ?? null,
            isDefault: true,
          },
        }).catch(() => undefined)
      }
    }

    // Create an admin notice so the new registration is visible in the dashboard notifications too
    await prisma.notice.create({
      data: {
        title: 'New customer registered',
        body: `${user.name} (${user.email}) created an account in the mobile app.`,
        at: 'Just now',
        page: 'customers',
      },
    }).catch(() => undefined)

    res.status(201).json(await buildUserPayload(user))
  } catch (error) {
    next(
      error instanceof z.ZodError
        ? new HttpError(400, error.issues[0]?.message || 'Check your sign-up details')
        : error,
    )
  }
})

authRouter.post('/forgot-password', async (req, res, next) => {
  try {
    const body = z.object({ email: z.string().email() }).parse(req.body)
    const email = body.email.toLowerCase()
    limit(`forgot:${email}`)
    const message = 'If an account exists for that email, a one-time reset code has been sent.'
    const user = await prisma.user.findUnique({ where: { email } })
    if (!user || user.role !== 'CUSTOMER') {
      res.json({ ok: true, message })
      return
    }

    const code = String(crypto.randomInt(100000, 999999))
    const passwordResetToken = await hashPassword(code)
    const passwordResetExpires = new Date(Date.now() + 15 * 60 * 1000)
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordResetToken, passwordResetExpires },
    })

    // No SMTP in local/dev — log the OTP and return it outside production for QA.
    console.info(`[password-reset] ${email} code=${code} expires=${passwordResetExpires.toISOString()}`)
    const payload: { ok: true; message: string; expiresInMinutes: number; devCode?: string } = {
      ok: true,
      message,
      expiresInMinutes: 15,
    }
    if (process.env.NODE_ENV !== 'production') {
      payload.devCode = code
    }
    res.json(payload)
  } catch (error) {
    next(error instanceof z.ZodError ? new HttpError(400, 'Enter a valid email address') : error)
  }
})

authRouter.post('/reset-password', async (req, res, next) => {
  try {
    const body = z
      .object({
        email: z.string().email(),
        code: z.string().trim().min(4).max(12),
        password: z.string().min(8, 'Password must be at least 8 characters').max(120),
      })
      .parse(req.body)
    const email = body.email.toLowerCase()
    limit(`reset:${email}`)
    const user = await prisma.user.findUnique({ where: { email } })
    if (
      !user ||
      user.role !== 'CUSTOMER' ||
      !user.passwordResetToken ||
      !user.passwordResetExpires ||
      user.passwordResetExpires.getTime() < Date.now()
    ) {
      throw new HttpError(400, 'Reset code is invalid or expired')
    }
    const valid = await checkPassword(body.code, user.passwordResetToken)
    if (!valid) throw new HttpError(400, 'Reset code is invalid or expired')

    const passwordHash = await hashPassword(body.password)
    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash,
        passwordResetToken: null,
        passwordResetExpires: null,
      },
    })
    await writeAudit({
      actorId: user.id,
      action: 'customer.password_reset',
      detail: 'Customer reset their password',
      meta: { source: 'mobile_app' },
    }).catch(() => undefined)

    res.json({ ok: true, message: 'Password updated. You can sign in now.' })
  } catch (error) {
    next(
      error instanceof z.ZodError
        ? new HttpError(400, error.issues[0]?.message || 'Check your reset details')
        : error,
    )
  }
})

authRouter.post('/change-password', requireAuth, async (req, res, next) => {
  try {
    const body = z
      .object({
        currentPassword: z.string().min(1, 'Current password is required'),
        newPassword: z.string().min(8, 'Password must be at least 8 characters').max(120),
      })
      .parse(req.body)
    const user = await prisma.user.findUnique({ where: { id: req.user!.id } })
    if (!user || user.role !== 'CUSTOMER') {
      throw new HttpError(403, 'Only customers can change password here')
    }
    if (!(await checkPassword(body.currentPassword, user.passwordHash))) {
      throw new HttpError(401, 'Current password is incorrect', 'INVALID_CREDENTIALS')
    }
    const passwordHash = await hashPassword(body.newPassword)
    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash,
        passwordResetToken: null,
        passwordResetExpires: null,
      },
    })
    await writeAudit({
      actorId: user.id,
      action: 'customer.password_change',
      detail: 'Customer changed their password',
      meta: { source: 'mobile_app' },
    }).catch(() => undefined)
    res.json({ ok: true, message: 'Password updated.' })
  } catch (error) {
    next(
      error instanceof z.ZodError
        ? new HttpError(400, error.issues[0]?.message || 'Check your password details')
        : error,
    )
  }
})

// Allows changing email and/or password with the current password (kainat + main compatibility).
authRouter.post('/change-credentials', requireAuth, async (req, res, next) => {
  try {
    const body = z
      .object({
        currentPassword: z.string().min(8),
        newEmail: z.string().email().optional(),
        newPassword: z.string().min(8).max(100).optional(),
      })
      .parse(req.body)
    if (!body.newEmail && !body.newPassword) throw new HttpError(400, 'Enter a new email or a new password')

    const user = await prisma.user.findUnique({ where: { id: req.user!.id } })
    if (!user) throw new HttpError(401, 'Sign in required')
    if (!(await checkPassword(body.currentPassword, user.passwordHash))) {
      throw new HttpError(400, 'Current password is incorrect')
    }

    const data: { email?: string; passwordHash?: string; passwordResetToken?: null; passwordResetExpires?: null } = {}
    if (body.newEmail) {
      const email = body.newEmail.toLowerCase()
      if (email !== user.email) {
        const taken = await prisma.user.findUnique({ where: { email } })
        if (taken) throw new HttpError(409, 'This email is already used by another account')
        data.email = email
      }
    }
    if (body.newPassword) {
      data.passwordHash = await hashPassword(body.newPassword)
      data.passwordResetToken = null
      data.passwordResetExpires = null
    }
    if (Object.keys(data).length > 0) await prisma.user.update({ where: { id: user.id }, data })

    res.json({ ok: true })
  } catch (error) {
    next(error instanceof z.ZodError ? new HttpError(400, 'Enter a valid email and a password of at least 8 characters') : error)
  }
})

authRouter.post('/login', async (req, res, next) => {
  try {
    const body = z.object({
      email: z.string().email(),
      password: z.string().min(6),
    }).parse(req.body)

    limit(body.email.toLowerCase())
    const user = await prisma.user.findUnique({ where: { email: body.email.toLowerCase() } })
    if (!user) {
      throw new HttpError(401, 'No account found. Please sign up first.', 'USER_NOT_FOUND')
    }
    if (!(await checkPassword(body.password, user.passwordHash))) {
      throw new HttpError(401, 'Email or password is incorrect', 'INVALID_CREDENTIALS')
    }

    if (user.role === 'RIDER') {
      const rider = await prisma.rider.findFirst({
        where: { userId: user.id },
      })

      if (!rider) throw new HttpError(403, 'No rider profile found for this account')

      if (rider.approvalStatus === 'pending') {
        throw new HttpError(
          403,
          'Your rider application is pending admin approval. You can sign in after approval.',
          'RIDER_PENDING',
        )
      }

      if (rider.approvalStatus === 'rejected') {
        throw new HttpError(
          403,
          rider.rejectedReason
            ? `Rider application rejected: ${rider.rejectedReason}`
            : 'Your rider application was rejected by admin.',
          'RIDER_REJECTED',
        )
      }

      if (!rider.active || !rider.storeId) {
        throw new HttpError(403, 'Your rider account is not assigned to a pharmacy yet')
      }
    }

    if (user.role === 'CUSTOMER') {
      await writeAudit({
        actorId: user.id,
        action: 'customer.login',
        detail: 'Customer signed in',
        meta: {
          source: 'mobile_app',
          customerId: user.id,
        },
      })
    }

    res.json(await buildUserPayload(user))
  } catch (error) {
    next(
      error instanceof z.ZodError
        ? new HttpError(400, 'Enter a valid email and password')
        : error,
    )
  }
})
/** Reconnects the mobile demo app to the primary saved customer account even if its email was edited. */
authRouter.post('/customer-bootstrap', async (_req, res, next) => {
  try {
    const user = await prisma.user.findFirst({
      where: { role: 'CUSTOMER' },
      orderBy: { createdAt: 'asc' },
    })
    if (!user) throw new HttpError(404, 'Customer account not found')
    res.json(await buildUserPayload(user))
  } catch (error) {
    next(error)
  }
})

authRouter.post('/store-context', requireAuth, async (req, res, next) => {
  try {
    if (req.user!.role !== 'CUSTOMER') {
      throw new HttpError(403, 'Customer account required')
    }

    const body = z.object({
      storeId: z.string().trim().min(1),
    }).parse(req.body)

    const store = await prisma.store.findFirst({
      where: {
        id: body.storeId,
        status: 'active',
      },
      select: {
        id: true,
        code: true,
        name: true,
        city: true,
      },
    })

    if (!store) {
      throw new HttpError(404, 'Selected pharmacy is not available')
    }

    await writeAudit({
      actorId: req.user!.id,
      storeId: store.id,
      action: 'customer.store_selected',
      detail: `Selected pharmacy: ${store.name}`,
      meta: {
        source: 'mobile_app',
        customerId: req.user!.id,
        storeCode: store.code,
        storeName: store.name,
        city: store.city,
      },
    })

    res.json({
      success: true,
      customerId: req.user!.id,
      store,
    })
  } catch (error) {
    next(
      error instanceof z.ZodError
        ? new HttpError(400, 'A valid store ID is required')
        : error,
    )
  }
})
authRouter.get('/me', requireAuth, async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user!.id } })
    if (!user) throw new HttpError(401, 'Sign in required')
    const payload = await buildUserPayload(user)
    res.json({ user: payload.user })
  } catch (error) {
    next(error)
  }
})

authRouter.post('/me/profile-photo', requireAuth, profilePhotoUpload.single('photo'), async (req, res, next) => {
  try {
    if (!req.file) throw new HttpError(400, 'Please select a profile photo')

    try {
      const updated = await prisma.user.update({
        where: { id: req.user!.id },
        data: { profilePhoto: `/uploads/profiles/${req.file.filename}` },
      })
      const payload = await buildUserPayload(updated)
      res.json({ user: payload.user })
    } catch (error) {
      await fs.promises.unlink(req.file.path).catch(() => undefined)
      throw error
    }
  } catch (error) {
    next(error)
  }
})

authRouter.patch('/me', requireAuth, async (req, res, next) => {
  try {
    const body = profileUpdateSchema.parse(req.body)
    const existing = await prisma.user.findUnique({ where: { id: req.user!.id } })
    if (!existing) throw new HttpError(401, 'Sign in required')

    const nextEmail = body.email ? body.email.toLowerCase() : existing.email
    if (nextEmail !== existing.email) {
      const taken = await prisma.user.findUnique({ where: { email: nextEmail } })
      if (taken && taken.id !== existing.id) {
        throw new HttpError(409, 'That email address is already in use')
      }
    }

    const updated = await prisma.user.update({
      where: { id: existing.id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.email !== undefined ? { email: nextEmail } : {}),
        ...(body.phone !== undefined ? { phone: body.phone } : {}),
        ...(body.city !== undefined ? { city: body.city } : {}),
        ...(body.dateOfBirth !== undefined ? { dateOfBirth: body.dateOfBirth } : {}),
        ...(body.gender !== undefined ? { gender: body.gender } : {}),
        ...(body.allergies !== undefined ? { allergies: body.allergies } : {}),
      },
    })

    if (existing.role === 'CUSTOMER' && Object.keys(body).length > 0) {
      await writeAudit({
        actorId: existing.id,
        action: 'customer.profile_updated',
        detail: 'Customer updated their profile',
        meta: { updatedFields: Object.keys(body) },
      }).catch(() => undefined)
    }
    res.json(await buildUserPayload(updated))
  } catch (error) {
    next(
      error instanceof z.ZodError
        ? new HttpError(400, error.issues[0]?.message || 'Check your account details')
        : error,
    )
  }
})

/** Public list of pharmacies riders can apply for (admin still assigns on approval). */
authRouter.get('/rider/stores', async (_req, res, next) => {
  try {
    const stores = await prisma.store.findMany({
      where: { status: 'active', acceptingOrders: true },
      select: { id: true, name: true, address: true, city: true },
      orderBy: { name: 'asc' },
    })
    res.json({ stores })
  } catch (error) {
    next(error)
  }
})

authRouter.post(
  '/rider/register',
  riderDocUpload.fields([
    { name: 'idDocument', maxCount: 1 },
    { name: 'licenseDocument', maxCount: 1 },
    { name: 'vehicleDocument', maxCount: 1 },
  ]),
  async (req, res, next) => {
    try {
      const body = z
        .object({
          name: z.string().trim().min(1).max(100),
          email: z.string().trim().email().max(160),
          password: z.string().min(6).max(120),
          phone: z.string().trim().min(6).max(40),
          vehicle: z.string().trim().max(40).optional(),
          preferredStoreId: z.string().trim().min(1).optional(),
          notes: z.string().trim().max(240).optional(),
        })
        .parse(req.body)

      const email = body.email.toLowerCase()
      limit(`rider-register:${email}`)

      const existing = await prisma.user.findUnique({ where: { email } })
      if (existing) {
        throw new HttpError(409, 'An account with this email already exists. Please sign in.')
      }

      const files = req.files as
        | Record<string, Express.Multer.File[]>
        | undefined
      const idDoc = files?.idDocument?.[0]
      const licenseDoc = files?.licenseDocument?.[0]
      const vehicleDoc = files?.vehicleDocument?.[0]

      if (!idDoc) throw new HttpError(400, 'Upload your national ID / identity document')
      if (!licenseDoc) throw new HttpError(400, 'Upload your driving license')

      if (body.preferredStoreId) {
        const store = await prisma.store.findFirst({
          where: { id: body.preferredStoreId, status: 'active' },
        })
        if (!store) throw new HttpError(400, 'Preferred pharmacy was not found')
      }

      const passwordHash = await hashPassword(body.password)
      const user = await prisma.user.create({
        data: {
          email,
          passwordHash,
          name: body.name,
          phone: body.phone,
          role: 'RIDER',
          storeId: body.preferredStoreId ?? null,
        },
      })

      const rider = await prisma.rider.create({
        data: {
          userId: user.id,
          storeId: body.preferredStoreId ?? null,
          name: body.name,
          phone: body.phone,
          vehicle: body.vehicle?.trim() || 'Bike',
          notes: body.notes ?? '',
          active: false,
          isPrimary: false,
          approvalStatus: 'pending',
          idDocumentUrl: `/uploads/riders/${idDoc.filename}`,
          licenseDocumentUrl: `/uploads/riders/${licenseDoc.filename}`,
          vehicleDocumentUrl: vehicleDoc ? `/uploads/riders/${vehicleDoc.filename}` : '',
        },
      })

      await prisma.notice.create({
        data: {
          title: 'New rider application',
          body: `${rider.name} applied as a rider and uploaded documents for review.`,
          at: 'Just now',
          page: 'pharmacies',
        },
      }).catch(() => undefined)

      res.status(201).json({
        ok: true,
        pending: true,
        message:
          'Application submitted. An admin must approve your documents before you can sign in.',
        rider: {
          id: rider.id,
          approvalStatus: rider.approvalStatus,
          name: rider.name,
          email,
        },
      })
    } catch (error) {
      next(
        error instanceof z.ZodError
          ? new HttpError(400, error.issues[0]?.message || 'Check your rider application details')
          : error,
      )
    }
  },
)


