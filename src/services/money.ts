import { Prisma } from '@prisma/client'

export function money(value: Prisma.Decimal | number | null | undefined) {
  if (value == null) return 0
  return Number(value)
}

export function dec(value: number) {
  return new Prisma.Decimal(value.toFixed(2))
}
