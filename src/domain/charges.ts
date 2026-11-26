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
  minDistanceKm?: number | null
  maxDistanceKm?: number | null
  perKmRate?: number | null
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
  deliveryZoneLabel?: string | null
  lines: AppliedCharge[]
}

export class DeliveryRuleConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DeliveryRuleConfigurationError'
  }
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
  if (rule.minDistanceKm != null && (!Number.isFinite(rule.minDistanceKm) || rule.minDistanceKm < 0)) {
    throw new Error(`${rule.label}: minimum distance must be zero or more`)
  }
  if (rule.maxDistanceKm != null && (!Number.isFinite(rule.maxDistanceKm) || rule.maxDistanceKm <= 0)) {
    throw new Error(`${rule.label}: maximum distance must be greater than zero`)
  }
  if (
    rule.minDistanceKm != null &&
    rule.maxDistanceKm != null &&
    rule.maxDistanceKm <= rule.minDistanceKm
  ) {
    throw new Error(`${rule.label}: maximum distance must be greater than minimum distance`)
  }
  if (rule.perKmRate != null && (!Number.isFinite(rule.perKmRate) || rule.perKmRate < 0)) {
    throw new Error(`${rule.label}: per-km rate must be zero or more`)
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

function hasDistanceBounds(rule: ChargeRuleInput) {
  return rule.minDistanceKm != null || rule.maxDistanceKm != null
}

function selectDeliveryRules(
  rules: ChargeRuleInput[],
  deliveryType: string,
  distanceKm?: number | null,
) {
  const activeDelivery = rules.filter(
    (item) => item.kind === 'DELIVERY' && item.active !== false,
  )

  // A delivery-type-specific rule takes priority over a universal rule.
  const specific = activeDelivery.filter((rule) => rule.deliveryType === deliveryType)
  const universal = activeDelivery.filter((rule) => !rule.deliveryType)
  const scopedRules = specific.length > 0 ? specific : universal

  if (distanceKm == null || !Number.isFinite(distanceKm)) {
    const flat = scopedRules.filter((rule) => !hasDistanceBounds(rule))
    if (flat.length > 0) return flat

    const sorted = [...scopedRules].sort(
      (a, b) => (a.minDistanceKm ?? 0) - (b.minDistanceKm ?? 0),
    )
    return sorted.length ? [sorted[0]] : []
  }

  const tiered = scopedRules.filter(hasDistanceBounds)
  if (tiered.length === 0) return scopedRules

  const safeDistance = Math.max(0, distanceKm)
  const matched = tiered.filter((rule) => {
    const minOk = rule.minDistanceKm == null || safeDistance >= rule.minDistanceKm
    const maxOk = rule.maxDistanceKm == null || safeDistance < rule.maxDistanceKm
    return minOk && maxOk
  })

  if (matched.length > 1) {
    throw new DeliveryRuleConfigurationError(
      `Overlapping ${deliveryType} delivery tiers match ${safeDistance} km. Please correct the delivery rules.`,
    )
  }

  if (matched.length === 1) return matched

  throw new DeliveryRuleConfigurationError(
    `No ${deliveryType} delivery charge is configured for ${safeDistance} km. Please contact the pharmacy.`,
  )
}

function applyKind(
  kind: ChargeKind,
  rules: ChargeRuleInput[],
  productSubtotal: number,
  delivery: number,
  service: number,
  distanceKm?: number | null,
  deliveryType = '',
) {
  const lines: AppliedCharge[] = []
  const selected =
    kind === 'DELIVERY'
      ? selectDeliveryRules(rules, deliveryType, distanceKm)
      : rules.filter((item) => item.kind === kind && item.active !== false)

  for (const rule of selected) {
    assertChargeRule(rule)
    const perKm = kind === 'DELIVERY' && rule.perKmRate != null && rule.perKmRate > 0
      ? rule.perKmRate
      : 0
    const extraKm =
      perKm > 0 && distanceKm != null && Number.isFinite(distanceKm)
        ? Math.max(0, distanceKm - (rule.minDistanceKm ?? 0))
        : 0
    const distanceSurcharge = perKm > 0 ? roundMoney(extraKm * perKm) : 0

    if (rule.mode === 'FIXED') {
      const amount = roundMoney(rule.amount + distanceSurcharge)
      lines.push({
        kind,
        label: rule.label,
        mode: rule.mode,
        rate: rule.amount,
        percentBase: null,
        baseAmount: extraKm > 0 ? roundMoney(extraKm) : 0,
        amount,
      })
      continue
    }

    const base = baseAmount(rule.percentBase!, productSubtotal, delivery, service)
    const amount = roundMoney((base * rule.amount) / 100 + distanceSurcharge)
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

/** Product prices stay on each line. Delivery, service, and BFP are applied in that order. */
export function calculateCharges(
  productSubtotal: number,
  deliveryType: string,
  rules: ChargeRuleInput[],
  distanceKm?: number | null,
): ChargeBreakdown {
  const delivery = applyKind(
    'DELIVERY',
    rules,
    productSubtotal,
    0,
    0,
    distanceKm,
    deliveryType,
  )
  const service = applyKind('SERVICE', rules, productSubtotal, delivery.total, 0)
  const bfp = applyKind('BFP', rules, productSubtotal, delivery.total, service.total)
  const lines = [...delivery.lines, ...service.lines, ...bfp.lines]

  return {
    productSubtotal: roundMoney(productSubtotal),
    deliveryCharge: delivery.total,
    serviceCharge: service.total,
    bfpCharge: bfp.total,
    total: roundMoney(productSubtotal + delivery.total + service.total + bfp.total),
    deliveryZoneLabel: delivery.lines[0]?.label ?? null,
    lines,
  }
}
