const API = 'http://127.0.0.1:4000'

async function login(email, password) {
  const r = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  const j = await r.json()
  if (!r.ok) throw new Error(`login ${JSON.stringify(j)}`)
  return j
}

const cust = await login('michael.johnson@email.com', 'HeraCustomer!234')
const headers = { Authorization: `Bearer ${cust.token}`, 'Content-Type': 'application/json' }

const storesPayload = await (await fetch(`${API}/catalog/stores`, { headers })).json()
const city = storesPayload.stores.find((s) => String(s.name).includes('City')) || storesPayload.stores[0]
const productsPayload = await (
  await fetch(`${API}/catalog/products?storeId=${encodeURIComponent(city.id)}`, { headers })
).json()
const item =
  productsPayload.products.find((p) => p.stock > 0 && !p.rxRequired) ||
  productsPayload.products.find((p) => p.stock > 0)
if (!item) throw new Error(`No in-stock product at ${city.name}`)
console.log('Using', item.name, 'at', city.name)

const place = await fetch(`${API}/orders`, {
  method: 'POST',
  headers,
  body: JSON.stringify({
    storeId: city.id,
    deliveryType: 'pickup',
    paymentLabel: 'Visa •••• 4829',
    addressLine: '',
    items: [{ productId: item.id, quantity: 1 }],
  }),
})
const text = await place.text()
console.log('place', place.status, text)
if (!place.ok) process.exit(1)
console.log('OK')
