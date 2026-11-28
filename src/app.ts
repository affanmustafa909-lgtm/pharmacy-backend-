import cors from 'cors'
import express from 'express'
import helmet from 'helmet'
import path from 'node:path'
import { adminOrderRouter } from './routes/adminOrders.js'
import { errorHandler } from './middleware/error.js'
import { adminRouter } from './routes/admin.js'
import { authRouter } from './routes/auth.js'
import { addressRouter } from './routes/addresses.js'
import { catalogRouter } from './routes/catalog.js'
import { customerOrderRouter } from './routes/customerOrders.js'
import { customerComplaintRouter } from './routes/customerComplaints.js'
import { importRouter } from './routes/import.js'
import { notificationRouter } from './routes/notifications.js'
import { prescriptionRouter } from './routes/prescriptions.js'
import { reminderRouter } from './routes/reminders.js'
import { reportRouter } from './routes/reports.js'
import { teamRouter } from './routes/team.js'
import { stockRouter } from './routes/stock.js'
import { purchasingRouter } from './routes/purchasing.js'
import { analyticsRouter } from './routes/analytics.js'
export function createApp() {
  const app = express()
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }))
  app.use(cors({ origin: true }))
  app.use(express.json({ limit: '1mb' }))
  // Prescription photos are private: browsers and shared caches must not keep them.
  app.use('/uploads/prescriptions', (_req, res, next) => {
    res.setHeader('Cache-Control', 'private, no-store')
    res.setHeader('X-Robots-Tag', 'noindex')
    next()
  })
  app.use('/uploads', express.static(path.resolve('uploads'), { index: false, dotfiles: 'deny' }))
  app.get('/health', (_req, res) => {
    res.json({ ok: true })
  })
  app.use('/auth', authRouter)
  app.use('/catalog', catalogRouter)
  app.use('/orders', customerOrderRouter)
  app.use('/complaints', customerComplaintRouter)
  app.use('/admin/orders', adminOrderRouter)
  app.use('/addresses', addressRouter)
  app.use('/reminders', reminderRouter)
  app.use('/prescriptions', prescriptionRouter)
  app.use('/notifications', notificationRouter)
  app.use('/admin/products/import', importRouter)
  app.use('/admin/reports', reportRouter)
  app.use('/admin/stock', stockRouter)
  app.use('/admin/purchasing', purchasingRouter)
app.use('/admin/analytics', analyticsRouter)
  app.use('/admin', teamRouter)
  app.use('/admin', adminRouter)
  app.use(errorHandler)
  return app
}