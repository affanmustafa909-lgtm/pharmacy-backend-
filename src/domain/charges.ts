export type ChargeKind = 'DELIVERY' | 'SERVICE' | 'BFP'
export type AmountMode = 'FIXED' | 'PERCENT'
export type PercentBase =
  | 'PRODUCT_SUBTOTAL'
  | 'DELIVERY'
  | 'SERVICE'
  | 'PRODUCT_AND_DELIVERY'
  | 'SUBTOTAL_BEFORE_BFP'

export interface ChargeRuleInput {
  kind: ChargeKind
  label: string
  mode: AmountMode
  amount: number
  percentBase: PercentBase | null
  deliveryType: string | null
  active?: boolean
}

export interface AppliedCharge {
  kind: ChargeKind
  label: string
  mode: AmountMode
  rate: number
  percentBase: PercentBase | null
  baseAmount: number
  amount: number
}

export interface ChargeBreakdown {
  productSubtotal: number
  deliveryCharge: number
  serviceCharge: number
  bfpCharge: number
  total: number
  lines: AppliedCharge[]
}

const ALLOWED_BASES: Record<ChargeKind, PercentBase[]> = {
  DELIVERY: ['PRODUCT_SUBTOTAL'],
  SERVICE: ['PRODUCT_SUBTOTAL', 'DELIVERY', 'PRODUCT_AND_DELIVERY'],
  BFP: ['PRODUCT_SUBTOTAL', 'DELIVERY', 'SERVICE', 'PRODUCT_AND_DELIVERY', 'SUBTOTAL_BEFORE_BFP'],
}

export function roundMoney(value: number) {
  if (!Number.isFinite(value)) return value
  const sign = value < 0 ? -1 : 1
  const cents = Math.round((Math.abs(value) + 1e-8) * 100)
  return (sign * cents) / 100
}

export function assertChargeRule(rule: ChargeRuleInput) {
  if (!Number.isFinite(rule.amount) || rule.amount < 0) {
    throw new Error(`${rule.label}: amount must be zero or more`)
  }
  if (rule.mode === 'PERCENT') {
    if (rule.amount > 100) throw new Error(`${rule.label}: percent cannot exceed 100`)
    if (!rule.percentBase) throw new Error(`${rule.label}: choose what the percent is calculated from`)
    if (!ALLOWED_BASES[rule.kind].includes(rule.percentBase)) {
      throw new Error(`${rule.label}: that percent base is not valid for this charge`)
    }
  }
}

function baseAmount(
  base: PercentBase,
  productSubtotal: number,
  delivery: number,
  service: number,
) {
  switch (base) {
    case 'PRODUCT_SUBTOTAL':
      return productSubtotal
    case 'DELIVERY':
      return delivery
    case 'SERVICE':
      return service
    case 'PRODUCT_AND_DELIVERY':
      return roundMoney(productSubtotal + delivery)
    case 'SUBTOTAL_BEFORE_BFP':
      return roundMoney(productSubtotal + delivery + service)
    default:
      throw new Error('Unknown percent base')
  }
}

function applyKind(
  kind: ChargeKind,
  rules: ChargeRuleInput[],
  productSubtotal: number,
  delivery: number,
  service: number,
) {
  const lines: AppliedCharge[] = []
  for (const rule of rules.filter((item) => item.kind === kind && item.active !== false)) {
    assertChargeRule(rule)
    if (rule.mode === 'FIXED') {
      const amount = roundMoney(rule.amount)
      lines.push({
        kind,
        label: rule.label,
        mode: rule.mode,
        rate: rule.amount,
        percentBase: null,
        baseAmount: 0,
        amount,
      })
      continue
    }
    const base = baseAmount(rule.percentBase!, productSubtotal, delivery, service)
    const amount = roundMoney((base * rule.amount) / 100)
    lines.push({
      kind,
      label: rule.label,
      mode: rule.mode,
      rate: rule.amount,
      percentBase: rule.percentBase,
      baseAmount: base,
      amount,
    })
  }
  const total = roundMoney(lines.reduce((sum, line) => sum + line.amount, 0))
  return { lines, total }
}

/** Product prices stay on each line. Delivery, service, and BFP are applied in that order
 * so a percent can name an earlier charge as its base. The returned lines are what an order stores. */
export function calculateCharges(
  productSubtotal: number,
  deliveryType: string,
  rules: ChargeRuleInput[],
): ChargeBreakdown {
  const applicable = rules.filter((rule) => !rule.deliveryType || rule.deliveryType === deliveryType)
  const delivery = applyKind('DELIVERY', applicable, productSubtotal, 0, 0)
  const service = applyKind('SERVICE', applicable, productSubtotal, delivery.total, 0)
  const bfp = applyKind('BFP', applicable, productSubtotal, delivery.total, service.total)
  const lines = [...delivery.lines, ...service.lines, ...bfp.lines]
  return {
    productSubtotal: roundMoney(productSubtotal),
    deliveryCharge: delivery.total,
    serviceCharge: service.total,
    bfpCharge: bfp.total,
    total: roundMoney(productSubtotal + delivery.total + service.total + bfp.total),
    lines,
  }
}
