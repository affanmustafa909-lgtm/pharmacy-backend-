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
  type: 'apple_pay' | 'card' | 'other'
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
    { id: 'apple', type: 'apple_pay', label: 'Apple Pay' },
    { id: 'visa', type: 'card', label: 'Visa', detail: '•••• 4829' },
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
    paymentMethods: Array.isArray(value.paymentMethods) && value.paymentMethods.length
      ? value.paymentMethods
      : DEFAULT_MOBILE_CONFIG.paymentMethods,
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
