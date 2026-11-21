import { Platform } from 'react-native';

import { PRODUCT_IMAGES } from '../data/products';
import type {
  Address,
  AppNotification,
  MobileConfig,
  Pharmacy,
  Prescription,
  Product,
  PromoInfo,
  Reminder,
  SearchSuggestion,
  StoreAvailability,
} from '../types';

export const API_BASE = Platform.OS === 'android' ? 'http://10.0.2.2:4000' : 'http://localhost:4000';

let token = '';

const TONES = ['blue', 'pink', 'mint', 'lavender'] as const;
const BOTTLES = ['#5EC8C0', '#F48FB1', '#81C784', '#B39DDB'];
const IMAGES: Record<string, number> = {
  'HER-CAL-090': PRODUCT_IMAGES.calcium,
  'HER-WMV-060': PRODUCT_IMAGES.multi,
  'HER-YAK-020': PRODUCT_IMAGES.yakapsule,
  'HER-IMC-060': PRODUCT_IMAGES.immune,
  'HER-LOR-030': PRODUCT_IMAGES.yakapsule,
};

export type CatalogProduct = {
  id: string;
  storeId: string;
  storeName: string;
  sku: string;
  name: string;
  brand: string;
  genericName?: string;
  strength?: string;
  price: number;
  unitLabel: string;
  description: string;
  category: string;
  imageUrl?: string;
  inStock: boolean;
  stock: number;
  rxRequired: boolean;
  batch?: string;
  expiry?: string;
  expired?: boolean;
};

export type ChargeQuote = {
  productSubtotal: number;
  deliveryCharge: number;
  serviceCharge: number;
  bfpCharge: number;
  discount?: number;
  promoCode?: string | null;
  total: number;
  etaMinutes?: number;
  storeName?: string;
  storeAddress?: string;
  openUntil?: string;
  requiresPrescription?: boolean;
};

export type ApiError = Error & { code?: string; status?: number };

export type ProfileUser = {
  id: string;
  name: string;
  email: string;
  phone: string;
  city: string;
  role: string;
};

async function request(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`API timeout (${API_BASE}${path})`)), 20000);
  });
  const response = (await Promise.race([
    fetch(`${API_BASE}${path}`, { ...init, headers }),
    timeout,
  ])) as Response;
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    let code: string | undefined;
    try {
      const payload = (await response.json()) as { message?: string; code?: string };
      if (payload.message) message = payload.message;
      code = payload.code;
    } catch {
      message = `Request failed (${response.status})`;
    }
    const error = new Error(message) as ApiError;
    error.status = response.status;
    error.code = code;
    throw error;
  }
  if (response.status === 204) return null;
  return response.json();
}

export async function loginCustomer() {
  // Login without sending a stale Authorization header (seed/restart can invalidate old user ids).
  const previous = token;
  token = '';
  try {
    const payload = (await request('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'michael.johnson@email.com', password: 'HeraCustomer!234' }),
    })) as { token: string };
    token = payload.token;
    return payload.token;
  } catch (error) {
    token = previous;
    throw error;
  }
}

export function clearCustomerSession() {
  token = '';
}

export async function loadProfile() {
  const payload = (await request('/auth/me')) as { user: ProfileUser };
  return payload.user;
}

export async function loadCatalog(query?: {
  q?: string;
  storeId?: string;
  category?: string;
  strength?: string;
  inStock?: boolean;
}) {
  const params = new URLSearchParams();
  if (query?.q) params.set('q', query.q);
  if (query?.storeId) params.set('storeId', query.storeId);
  if (query?.category) params.set('category', query.category);
  if (query?.strength) params.set('strength', query.strength);
  if (query?.inStock != null) params.set('inStock', String(query.inStock));
  const suffix = params.toString() ? `?${params}` : '';
  const payload = (await request(`/catalog/products${suffix}`)) as { products: CatalogProduct[] };
  return payload.products.map(toProduct);
}

export async function loadSuggestions(q: string): Promise<SearchSuggestion[]> {
  if (!q.trim()) return [];
  const params = new URLSearchParams({ q: q.trim() });
  const payload = (await request(`/catalog/suggest?${params}`)) as { suggestions: SearchSuggestion[] };
  return payload.suggestions;
}

export async function loadCategories(): Promise<string[]> {
  const payload = (await request('/catalog/categories')) as { categories: string[] };
  return payload.categories.filter(Boolean);
}

export async function loadStrengths(storeId?: string): Promise<string[]> {
  const params = new URLSearchParams();
  if (storeId) params.set('storeId', storeId);
  const suffix = params.toString() ? `?${params}` : '';
  const payload = (await request(`/catalog/strengths${suffix}`)) as { strengths: string[] };
  return payload.strengths.filter(Boolean);
}

export async function loadProduct(id: string): Promise<Product> {
  const payload = (await request(`/catalog/products/${encodeURIComponent(id)}`)) as { product: CatalogProduct };
  return toProduct(payload.product, 0);
}

export async function loadAvailability(id: string): Promise<{ sku: string; stores: StoreAvailability[] }> {
  return request(`/catalog/products/${encodeURIComponent(id)}/availability`) as Promise<{
    sku: string;
    stores: StoreAvailability[];
  }>;
}

export async function notifyBackInStock(productId: string) {
  return request(`/catalog/products/${encodeURIComponent(productId)}/notify`, {
    method: 'POST',
    body: '{}',
  }) as Promise<{ id: string; active: boolean }>;
}

export async function loadStores(): Promise<Pharmacy[]> {
  const payload = (await request('/catalog/stores')) as {
    stores: {
      id: string;
      name: string;
      address: string;
      openUntil: string;
      rating: number;
      pharmacist?: string;
    }[];
  };
  return payload.stores.map((store) => ({
    id: store.id,
    name: store.name,
    distance: 'Nearby',
    openUntil: store.openUntil,
    rating: store.rating,
    address: store.address,
    pharmacist: store.pharmacist,
  }));
}

export async function loadReminders(): Promise<Reminder[]> {
  const payload = (await request('/reminders/mine')) as { reminders: Reminder[] };
  return payload.reminders;
}

export async function createReminder(input: {
  medicine: string;
  time: string;
  frequency: string;
  productId?: string;
  orderNumber?: string;
}) {
  const payload = (await request('/reminders', {
    method: 'POST',
    body: JSON.stringify(input),
  })) as { reminder: Reminder };
  return payload.reminder;
}

export async function updateReminder(
  id: string,
  patch: Partial<Pick<Reminder, 'medicine' | 'time' | 'frequency' | 'enabled' | 'productId' | 'orderNumber'>>,
) {
  const payload = (await request(`/reminders/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })) as { reminder: Reminder };
  return payload.reminder;
}

export async function toggleReminder(id: string) {
  return request(`/reminders/${id}/toggle`, { method: 'POST', body: '{}' }) as Promise<{ id: string; enabled: boolean }>;
}

export async function snoozeReminder(id: string, hours = 4) {
  const payload = (await request(`/reminders/${id}/snooze`, {
    method: 'POST',
    body: JSON.stringify({ hours }),
  })) as { reminder: Reminder };
  return payload.reminder;
}

export async function deleteReminder(id: string) {
  await request(`/reminders/${id}`, { method: 'DELETE' });
}

export async function loadMyOrders() {
  const payload = (await request('/orders/mine')) as {
    orders: {
      id: string;
      total: number;
      status: string;
      storeName: string;
      deliveryType: string;
      paymentLabel: string;
      createdAt: string;
      itemCount: number;
      items: {
        productId?: string | null;
        name: string;
        sku: string;
        unitPrice: number;
        quantity: number;
        lineTotal: number;
      }[];
    }[];
  };
  return payload.orders;
}

export async function buyAgain(orderNumber: string, storeId?: string) {
  return request('/orders/buy-again', {
    method: 'POST',
    body: JSON.stringify({ orderNumber, storeId }),
  }) as Promise<{
    orderNumber: string;
    storeId: string;
    lines: {
      sku: string;
      name: string;
      quantity: number;
      productId?: string;
      price?: number;
      available: boolean;
      reason?: string | null;
      rxRequired?: boolean;
    }[];
  }>;
}

export async function loadReceipt(number: string) {
  return request(`/orders/${encodeURIComponent(number)}/receipt`) as Promise<{
    id: string;
    html: string;
    total: number;
    productSubtotal: number;
    deliveryCharge: number;
    serviceCharge: number;
    bfpCharge: number;
    discount: number;
    items: { name: string; quantity: number; unitPrice: number; lineTotal: number }[];
  }>;
}

export async function loadNotifications() {
  return request('/notifications/mine') as Promise<{ unreadCount: number; notifications: AppNotification[] }>;
}

export async function markNotificationsRead(ids?: string[], all?: boolean) {
  return request('/notifications/read', {
    method: 'POST',
    body: JSON.stringify(all ? { all: true } : { ids }),
  });
}

export async function loadPrescriptions(): Promise<Prescription[]> {
  const payload = (await request('/prescriptions/mine')) as { prescriptions: Prescription[] };
  return payload.prescriptions;
}

export async function submitPrescription(input: {
  storeId: string;
  scannedText?: string;
  customerNote?: string;
  medicineName?: string;
  imageUri: string;
  fileName?: string;
  mimeType?: string;
}) {
  const form = new FormData();
  form.append('storeId', input.storeId);
  if (input.scannedText) form.append('scannedText', input.scannedText);
  if (input.customerNote) form.append('customerNote', input.customerNote);
  if (input.medicineName) form.append('medicineName', input.medicineName);
  form.append('image', {
    uri: input.imageUri,
    name: input.fileName || 'prescription.jpg',
    type: input.mimeType || 'image/jpeg',
  } as unknown as Blob);
  const payload = (await request('/prescriptions', { method: 'POST', body: form })) as {
    prescription: Prescription;
  };
  return payload.prescription;
}

export async function replacePrescriptionImage(number: string, input: { imageUri: string; scannedText?: string }) {
  const form = new FormData();
  if (input.scannedText) form.append('scannedText', input.scannedText);
  form.append('image', {
    uri: input.imageUri,
    name: 'prescription.jpg',
    type: 'image/jpeg',
  } as unknown as Blob);
  const payload = (await request(`/prescriptions/${encodeURIComponent(number)}/replace-image`, {
    method: 'POST',
    body: form,
  })) as { prescription: Prescription };
  return payload.prescription;
}

export async function loadMobileConfig(): Promise<{ config: MobileConfig; promos: PromoInfo[] }> {
  return request('/catalog/mobile-config') as Promise<{ config: MobileConfig; promos: PromoInfo[] }>;
}

export async function validatePromo(code: string): Promise<PromoInfo> {
  const params = new URLSearchParams({ code: code.trim() });
  return request(`/catalog/promos/validate?${params}`) as Promise<PromoInfo>;
}

export async function loadMyAddresses(): Promise<Address[]> {
  const payload = (await request('/addresses/mine')) as {
    addresses: {
      id: string;
      label: string;
      line: string;
      latitude?: number | null;
      longitude?: number | null;
      isDefault: boolean;
    }[];
  };

  return payload.addresses.map((item) => ({
    id: item.id,
    label: item.label,
    line: item.line,
    latitude: item.latitude,
    longitude: item.longitude,
  }));
}

export async function createAddress(input: {
  label: string;
  line: string;
  latitude?: number | null;
  longitude?: number | null;
  isDefault?: boolean;
}) {
  const created = (await request('/addresses', {
    method: 'POST',
    body: JSON.stringify(input),
  })) as {
    id: string;
    label: string;
    line: string;
    latitude?: number | null;
    longitude?: number | null;
    isDefault: boolean;
  };

  return {
    id: created.id,
    label: created.label,
    line: created.line,
    latitude: created.latitude,
    longitude: created.longitude,
  };
}
export async function deleteAddress(id: string) {
  await request(`/addresses/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function loadOrderByNumber(number: string) {
  return request(`/orders/${encodeURIComponent(number)}`) as Promise<{
    id: string;
    status: string;
    total: number;
    discount: number;
    deliveryType: 'standard' | 'express' | 'pickup';
    paymentLabel: string;
    addressLine: string;
    storeName: string;
    storeAddress?: string;
    openUntil?: string;
    createdAt: string;
    productSubtotal: number;
    deliveryCharge: number;
    serviceCharge: number;
    bfpCharge: number;
    itemCount: number;
    items?: {
      productId?: string | null;
      name: string;
      sku: string;
      unitPrice: number;
      quantity: number;
      lineTotal: number;
    }[];
    steps: { id: string; title: string; completed: boolean }[];
  }>;
}

export function toProduct(raw: CatalogProduct, index = 0): Product {
  const remoteImage = raw.imageUrl
    ? { uri: raw.imageUrl.startsWith('http') ? raw.imageUrl : `${API_BASE}${raw.imageUrl}` }
    : undefined;
  return {
    id: raw.id,
    storeId: raw.storeId,
    storeName: raw.storeName,
    sku: raw.sku,
    name: raw.name,
    brand: raw.brand,
    genericName: raw.genericName,
    strength: raw.strength,
    price: raw.price,
    unitLabel: raw.unitLabel,
    packSize: raw.unitLabel,
    description: raw.description,
    longDescription: raw.description,
    category: raw.category,
    inStock: raw.inStock,
    stock: raw.stock,
    batch: raw.batch,
    expiry: raw.expiry,
    expired: raw.expired,
    rxRequired: raw.rxRequired,
    cardTone: TONES[index % TONES.length],
    bottleTone: BOTTLES[index % BOTTLES.length],
    image: remoteImage ?? IMAGES[raw.sku],
  };
}

export function quoteOrder(input: {
  storeId: string;
  deliveryType: 'standard' | 'express' | 'pickup';
  promoCode?: string;
  prescriptionNumber?: string;
  items: { productId: string; quantity: number }[];
}) {
  return request('/orders/quote', { method: 'POST', body: JSON.stringify(input) }) as Promise<ChargeQuote>;
}

export async function placeCustomerOrder(input: {
  storeId: string;
  deliveryType: 'standard' | 'express' | 'pickup';
  paymentLabel: string;
  addressLine: string;
  promoCode?: string;
  prescriptionNumber?: string;
  items: { productId: string; quantity: number }[];
}) {
  const place = () =>
    request('/orders', { method: 'POST', body: JSON.stringify(input) }) as Promise<{
      id: string;
      total: number;
      itemCount: number;
      deliveryType: 'standard' | 'express' | 'pickup';
      paymentLabel: string;
      createdAt: string;
      productSubtotal: number;
      deliveryCharge: number;
      serviceCharge: number;
      bfpCharge: number;
      discount: number;
    }>;

  try {
    await loginCustomer();
    return await place();
  } catch (error) {
    const apiError = error as ApiError;
    const needsFreshSession =
      apiError.status === 401 ||
      /sign in again|sign in required/i.test(apiError.message || '');
    if (!needsFreshSession) throw error;
    clearCustomerSession();
    await loginCustomer();
    return place();
  }
}
