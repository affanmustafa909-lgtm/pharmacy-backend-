import type { NextFunction, Request, Response } from 'express'
import { HttpError } from '../lib/http.js'

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) {
    res.status(err.status).json({ message: err.message, ...(err.code ? { code: err.code } : {}) })
    return
  }
  console.error(err)
  res.status(500).json({ message: 'Something went wrong' })
}
