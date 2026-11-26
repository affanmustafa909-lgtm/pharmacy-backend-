
import type { NextFunction, Request, Response } from 'express'
import { HttpError } from '../lib/http.js'

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
) {
  if (err instanceof HttpError) {
    res.status(err.status).json({
      message: err.message,
      ...(err.code ? { code: err.code } : {})
    })
    return
  }
<<<<<<< Updated upstream
  console.error(err)
=======

  console.error('BACKEND ERROR:', err)

  if (process.env.NODE_ENV !== 'production') {
    const error = err instanceof Error ? err : new Error(String(err))

    res.status(500).json({
      message: error.message,
      name: error.name,
      stack: error.stack
    })
    return
  }

>>>>>>> Stashed changes
  res.status(500).json({ message: 'Something went wrong' })
}
