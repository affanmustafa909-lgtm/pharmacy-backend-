import cors from 'cors'
import express from 'express'
import helmet from 'helmet'
import path from 'node:path'
import { errorHandler } from './middleware/error.js'
import { adminRouter } from './routes/admin.js'
import { authRouter } from './routes/auth.js'
import { addressRouter } from './routes/addresses.js'
import { catalogRouter } from './routes/catalog.js'
import { customerOrderRouter } from './routes/customerOrders.js'
import { importRouter } from './routes/import.js'
import { notificationRouter } from './routes/notifications.js'
import { prescriptionRouter } from './routes/prescriptions.js'
import { reminderRouter } from './routes/reminders.js'
import { reportRouter } from './routes/reports.js'
import { riderRouter } from './routes/rider.js'
import { teamRouter } from './routes/team.js'

export function createApp() {
  const app = express()
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }))
  app.use(cors({ origin: true }))
  app.use(express.json({ limit: '1mb' }))
  app.use('/uploads', express.static(path.resolve('uploads')))
  app.get('/health', (_req, res) => {
    res.json({ ok: true })
  })
  app.use('/auth', authRouter)
  app.use('/catalog', catalogRouter)
  app.use('/orders', customerOrderRouter)
  app.use('/addresses', addressRouter)
  app.use('/reminders', reminderRouter)
  app.use('/prescriptions', prescriptionRouter)
  app.use('/notifications', notificationRouter)
  app.use('/rider', riderRouter)
  app.use('/admin/products/import', importRouter)
  app.use('/admin/reports', reportRouter)
  app.use('/admin', teamRouter)
  app.use('/admin', adminRouter)
  app.use(errorHandler)
  return app
}
