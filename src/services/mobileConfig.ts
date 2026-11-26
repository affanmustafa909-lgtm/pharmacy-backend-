export type MobileQuickAction = {
  id: string
  label: string
  icon: string
  href: string
}

export type MobileDeliveryOption = {
  id: 'standard' | 'express' | 'pickup'
  title: string
  eta: string
  priceLabel: string
  highlighted?: boolean
}

export type MobilePaymentMethod = {
  id: string
  type: 'apple_pay' | 'card' | 'debit_card' | 'credit_card' | 'cod' | 'other'
  label: string
  detail?: string
}

export type MobileAiMessage = {
  id: string
  role: 'assistant' | 'user'
  text: string
}

export type MobileConfig = {
  heroLight: string
  heroBold: string
  quickActions: MobileQuickAction[]
  deliveryOptions: MobileDeliveryOption[]
  paymentMethods: MobilePaymentMethod[]
  aiMessages: MobileAiMessage[]
  tracking: {
    riderName: string
    expressEtaMinutes: number
    standardEtaMinutes: number
    pickupEtaMinutes: number
    defaultDistanceKm: number
  }
}

export const DEFAULT_MOBILE_CONFIG: MobileConfig = {
  heroLight: 'Find Your',
  heroBold: 'Medicines Fast',
  quickActions: [
    { id: 'upload', label: 'Upload', icon: 'camera-outline', href: '/scan' },
    { id: 'order', label: 'Order', icon: 'bag-outline', href: '/(tabs)/cart' },
    { id: 'pharmacy', label: 'Pharmacy', icon: 'location-outline', href: '/pharmacies' },
    { id: 'reminder', label: 'Reminder', icon: 'time-outline', href: '/reminders' },
  ],
  deliveryOptions: [
    { id: 'standard', title: 'Standard', eta: '45-60 min', priceLabel: 'From charges' },
    { id: 'express', title: 'Express', eta: '20-30 min', priceLabel: 'From charges', highlighted: true },
    { id: 'pickup', title: 'Store Pickup', eta: 'Ready in 30-45 min', priceLabel: 'Free' },
  ],
  paymentMethods: [
    { id: 'cod', type: 'cod', label: 'Cash on Delivery' },
    { id: 'debit', type: 'debit_card', label: 'Debit Card', detail: 'TEST MODE' },
    { id: 'credit', type: 'credit_card', label: 'Credit Card', detail: 'TEST MODE' },
  ],
  aiMessages: [
    {
      id: 'm1',
      role: 'assistant',
      text: 'Hi — I’m Hera AI. Ask me about medicines, side effects, or what to take for common symptoms.',
    },
    {
      id: 'm2',
      role: 'user',
      text: 'I have a mild headache and fever. What should I take?',
    },
    {
      id: 'm3',
      role: 'assistant',
      text: 'For mild headache and fever, Yakapsule 500mg is commonly recommended: 1 tablet up to 3 times a day for 5 days. Stay hydrated and rest.',
    },
  ],
  tracking: {
    riderName: 'Alex',
    expressEtaMinutes: 25,
    standardEtaMinutes: 45,
    pickupEtaMinutes: 40,
    defaultDistanceKm: 2.4,
  },
}

function normalizePaymentMethods(raw: unknown): MobilePaymentMethod[] {
  const list = Array.isArray(raw) ? (raw as MobilePaymentMethod[]) : []
  const hasSimCards = list.some(
    (method) =>
      method?.type === 'debit_card' ||
      method?.type === 'credit_card' ||
      (method?.type === 'card' && /test/i.test(String(method.detail ?? ''))),
  )
  // Replace legacy Apple Pay / saved Visa configs with the TEST MODE simulation set.
  if (!list.length || !hasSimCards) {
    return DEFAULT_MOBILE_CONFIG.paymentMethods
  }

  const cleaned = list
    .filter((method) => method && method.type !== 'apple_pay')
    .map((method) => {
      if (method.type === 'card' && !/test/i.test(String(method.detail ?? ''))) {
        return {
          ...method,
          type: 'debit_card' as const,
          label: method.label?.trim() || 'Debit Card',
          detail: 'TEST MODE',
        }
      }
      if (method.type === 'debit_card' || method.type === 'credit_card') {
        return { ...method, detail: method.detail?.trim() || 'TEST MODE' }
      }
      return method
    })

  const withCod = cleaned.some((method) => method.type === 'cod' || method.id === 'cod')
    ? cleaned
    : [{ id: 'cod', type: 'cod' as const, label: 'Cash on Delivery' }, ...cleaned]

  const hasDebit = withCod.some((method) => method.type === 'debit_card' || method.id === 'debit')
  const hasCredit = withCod.some((method) => method.type === 'credit_card' || method.id === 'credit')
  const next = [...withCod]
  if (!hasDebit) next.push({ id: 'debit', type: 'debit_card', label: 'Debit Card', detail: 'TEST MODE' })
  if (!hasCredit) next.push({ id: 'credit', type: 'credit_card', label: 'Credit Card', detail: 'TEST MODE' })
  return next
}

export function normalizeMobileConfig(raw: unknown): MobileConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return DEFAULT_MOBILE_CONFIG
  const value = raw as Partial<MobileConfig>
  return {
    heroLight: value.heroLight?.trim() || DEFAULT_MOBILE_CONFIG.heroLight,
    heroBold: value.heroBold?.trim() || DEFAULT_MOBILE_CONFIG.heroBold,
    quickActions: Array.isArray(value.quickActions) && value.quickActions.length
      ? value.quickActions
      : DEFAULT_MOBILE_CONFIG.quickActions,
    deliveryOptions: Array.isArray(value.deliveryOptions) && value.deliveryOptions.length
      ? value.deliveryOptions
      : DEFAULT_MOBILE_CONFIG.deliveryOptions,
    paymentMethods: normalizePaymentMethods(value.paymentMethods),
    aiMessages: Array.isArray(value.aiMessages) && value.aiMessages.length
      ? value.aiMessages
      : DEFAULT_MOBILE_CONFIG.aiMessages,
    tracking: {
      riderName: value.tracking?.riderName?.trim() || DEFAULT_MOBILE_CONFIG.tracking.riderName,
      expressEtaMinutes: Number(value.tracking?.expressEtaMinutes) || DEFAULT_MOBILE_CONFIG.tracking.expressEtaMinutes,
      standardEtaMinutes: Number(value.tracking?.standardEtaMinutes) || DEFAULT_MOBILE_CONFIG.tracking.standardEtaMinutes,
      pickupEtaMinutes: Number(value.tracking?.pickupEtaMinutes) || DEFAULT_MOBILE_CONFIG.tracking.pickupEtaMinutes,
      defaultDistanceKm: Number(value.tracking?.defaultDistanceKm) || DEFAULT_MOBILE_CONFIG.tracking.defaultDistanceKm,
    },
  }
}
