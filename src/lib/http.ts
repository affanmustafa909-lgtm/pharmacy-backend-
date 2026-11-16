export class HttpError extends Error {
  code?: string

  constructor(
    public status: number,
    message: string,
    code?: string,
  ) {
    super(message)
    this.code = code
  }
}

export function pageParams(query: Record<string, unknown>) {
  const page = Math.max(1, Number(query.page ?? 1) || 1)
  const pageSize = Math.min(100, Math.max(1, Number(query.pageSize ?? 20) || 20))
  return { page, pageSize, skip: (page - 1) * pageSize }
}
