import 'dotenv/config'
import { PrismaClient } from '@prisma/client'
import { hashPassword } from '../src/lib/auth.js'
import { DEFAULT_MOBILE_CONFIG } from '../src/services/mobileConfig.js'
import { dec } from '../src/services/money.js'

const prisma = new PrismaClient()

/** Demo store codes owned by the seed. User-created stores (any other code) are never deleted. */
const DEMO_CODES = ['ALI', 'CTY', 'HCP', 'NEW'] as const

async function wipeAll() {
  await prisma.orderActivity.deleteMany()
  await prisma.orderCharge.deleteMany()
  await prisma.orderItem.deleteMany()
  await prisma.order.deleteMany()
  await prisma.stockMovement.deleteMany()
  await prisma.inventoryBatch.deleteMany()
  await prisma.storeDeliveryOption.deleteMany()
  await prisma.staffInvite.deleteMany()
  await prisma.storeAssignment.deleteMany()
  await prisma.auditLog.deleteMany()
  await prisma.chargeRule.deleteMany()
  await prisma.service.deleteMany()
  await prisma.message.deleteMany()
  await prisma.messageThread.deleteMany()
  await prisma.customerNotification.deleteMany()
  await prisma.stockAlert.deleteMany()
  await prisma.prescription.deleteMany()
  await prisma.product.deleteMany()
  await prisma.rider.deleteMany()
  await prisma.notice.deleteMany()
  await prisma.payout.deleteMany()
  await prisma.reminder.deleteMany()
  await prisma.campaign.deleteMany()
  await prisma.careEvent.deleteMany()
  await prisma.customerAddress.deleteMany()
  await prisma.promoCode.deleteMany()
  await prisma.user.deleteMany()
  await prisma.store.deleteMany()
  await prisma.setting.deleteMany()
}

async function main() {
  const force = process.env.FORCE_SEED === '1' || process.env.FORCE_SEED === 'true'
  const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? 'HeraAdmin!234'
  const staffPassword = process.env.SEED_STAFF_PASSWORD ?? 'HeraStaff!234'
  const managerPassword = process.env.SEED_MANAGER_PASSWORD ?? 'HeraManager!234'
  const customerPassword = process.env.SEED_CUSTOMER_PASSWORD ?? 'HeraCustomer!234'

  if (force) {
    console.log('FORCE_SEED=1 — wiping all data, including user-created stores')
    await wipeAll()
  } else {
    console.log('Safe seed — demo data only. User-created stores are preserved.')
    console.log('Set FORCE_SEED=1 to fully reset the database.')
  }

  const defaultHours = {
    mon: { open: '09:00', close: '22:00' },
    tue: { open: '09:00', close: '22:00' },
    wed: { open: '09:00', close: '22:00' },
    thu: { open: '09:00', close: '22:00' },
    fri: { open: '09:00', close: '22:00' },
    sat: { open: '10:00', close: '20:00' },
    sun: { open: '10:00', close: '18:00' },
  }

  const storeDefs = [
    {
      code: 'ALI',
      name: 'Ali Pharmacy',
      address: '245 Park Ave, New York, NY',
      openUntil: '10:00 PM',
      pharmacist: 'Ava Patel',
      phone: '+1 (212) 555-0100',
      rating: 4.9,
      mapLat: 40.7549,
      mapLng: -73.974,
    },
    {
      code: 'CTY',
      name: 'City Pharmacy',
      address: '180 8th Ave, New York, NY',
      openUntil: '9:00 PM',
      pharmacist: 'Leo Martins',
      phone: '+1 (212) 555-0108',
      rating: 4.7,
      mapLat: 40.742,
      mapLng: -74.001,
    },
    {
      code: 'HCP',
      name: 'Health Care Pharmacy',
      address: '920 Lexington Ave, New York, NY',
      openUntil: '8:00 PM',
      pharmacist: 'Mina Rahman',
      phone: '+1 (212) 555-0119',
      rating: 4.8,
      mapLat: 40.7701,
      mapLng: -73.9642,
    },
    {
      code: 'NEW',
      name: 'New Branch Pharmacy',
      address: '100 Broadway, New York, NY',
      openUntil: '9:00 PM',
      pharmacist: 'Nina Manager',
      phone: '+1 (212) 555-0199',
      rating: 4.6,
      mapLat: 40.7074,
      mapLng: -74.0113,
    },
  ] as const

  const stores: Record<string, { id: string; code: string }> = {}
  for (const def of storeDefs) {
    const store = await prisma.store.upsert({
      where: { code: def.code },
      create: {
        ...def,
        weeklyHours: defaultHours,
        status: 'active',
        acceptingOrders: true,
        isOpen: true,
      },
      update: {
        name: def.name,
        address: def.address,
        openUntil: def.openUntil,
        pharmacist: def.pharmacist,
        phone: def.phone,
        rating: def.rating,
        weeklyHours: defaultHours,
        status: 'active',
        acceptingOrders: true,
        isOpen: true,
        mapLat: def.mapLat,
        mapLng: def.mapLng,
      },
    })
    stores[def.code] = store
  }

  const ava = await prisma.user.upsert({
    where: { email: 'ava@hera.care' },
    create: {
      email: 'ava@hera.care',
      name: 'Ava Patel',
      role: 'ADMIN',
      deskRole: 'OWNER',
      canChangePrice: true,
      canRefund: true,
      passwordHash: await hashPassword(adminPassword),
      phone: '+1 (212) 555-0100',
      city: 'New York, NY',
    },
    update: {
      role: 'ADMIN',
      deskRole: 'OWNER',
      canChangePrice: true,
      canRefund: true,
      passwordHash: await hashPassword(adminPassword),
    },
  })
  const leo = await prisma.user.upsert({
    where: { email: 'leo@hera.care' },
    create: {
      email: 'leo@hera.care',
      name: 'Leo Martins',
      role: 'STAFF',
      deskRole: 'PHARMACIST',
      storeId: stores.CTY.id,
      passwordHash: await hashPassword(staffPassword),
      city: 'New York, NY',
    },
    update: {
      role: 'STAFF',
      deskRole: 'PHARMACIST',
      storeId: stores.CTY.id,
      passwordHash: await hashPassword(staffPassword),
    },
  })
  const nina = await prisma.user.upsert({
    where: { email: 'nina@hera.care' },
    create: {
      email: 'nina@hera.care',
      name: 'Nina Manager',
      role: 'STAFF',
      deskRole: 'STORE_MANAGER',
      storeId: stores.NEW.id,
      canChangePrice: true,
      canRefund: false,
      passwordHash: await hashPassword(managerPassword),
      phone: '+1 (212) 555-0198',
      city: 'New York, NY',
    },
    update: {
      role: 'STAFF',
      deskRole: 'STORE_MANAGER',
      storeId: stores.NEW.id,
      canChangePrice: true,
      canRefund: false,
      passwordHash: await hashPassword(managerPassword),
    },
  })
  const michael = await prisma.user.upsert({
    where: { email: 'michael.johnson@email.com' },
    create: {
      email: 'michael.johnson@email.com',
      name: 'Michael Johnson',
      role: 'CUSTOMER',
      passwordHash: await hashPassword(customerPassword),
      phone: '+1 (212) 555-0148',
      city: 'New York, NY',
    },
    update: {
      passwordHash: await hashPassword(customerPassword),
      phone: '+1 (212) 555-0148',
    },
  })

  // Owner assignments for every store the owner should see (demo + any user-created).
  const allStores = await prisma.store.findMany({ select: { id: true, code: true } })
  for (const store of allStores) {
    await prisma.storeAssignment.upsert({
      where: { userId_storeId: { userId: ava.id, storeId: store.id } },
      create: {
        userId: ava.id,
        storeId: store.id,
        deskRole: 'OWNER',
        canChangePrice: true,
        canRefund: true,
      },
      update: {
        deskRole: 'OWNER',
        canChangePrice: true,
        canRefund: true,
      },
    })
  }
  await prisma.storeAssignment.upsert({
    where: { userId_storeId: { userId: leo.id, storeId: stores.CTY.id } },
    create: {
      userId: leo.id,
      storeId: stores.CTY.id,
      deskRole: 'PHARMACIST',
    },
    update: { deskRole: 'PHARMACIST' },
  })
  await prisma.storeAssignment.upsert({
    where: { userId_storeId: { userId: nina.id, storeId: stores.NEW.id } },
    create: {
      userId: nina.id,
      storeId: stores.NEW.id,
      deskRole: 'STORE_MANAGER',
      canChangePrice: true,
      canRefund: false,
    },
    update: {
      deskRole: 'STORE_MANAGER',
      canChangePrice: true,
      canRefund: false,
    },
  })

  await prisma.store.update({
    where: { id: stores.CTY.id },
    data: { pharmacistUserId: leo.id, pharmacist: leo.name },
  })
  await prisma.store.update({
    where: { id: stores.NEW.id },
    data: { managerUserId: nina.id, pharmacistUserId: nina.id, pharmacist: nina.name },
  })

  const products = [
    { storeCode: 'ALI', sku: 'HER-CAL-090', name: 'Calcium Care', genericName: 'Calcium carbonate', strength: '600mg', category: 'Supplements', price: 29, unitLabel: '90 tablets', stock: 128, imageUrl: '/uploads/products/HER-CAL-090.jpg', description: 'Calcium with vitamin D3 for bone strength and everyday muscle support.' },
    { storeCode: 'ALI', sku: 'HER-WMV-060', name: 'Women Multivitamin', genericName: 'Multivitamin', strength: 'Daily', category: 'Vitamins', price: 29.99, unitLabel: '60 capsules', stock: 86, imageUrl: '/uploads/products/HER-WMV-060.jpg', description: 'Daily multivitamin for energy, immunity, and hair, skin, and nails.' },
    { storeCode: 'ALI', sku: 'HER-YAK-020', name: 'Yakapsule 500mg', genericName: 'Paracetamol', strength: '500mg', category: 'Medicines', price: 18.5, unitLabel: '20 tablets', stock: 240, imageUrl: '/uploads/products/HER-YAK-020.jpg', description: 'Fast-acting relief for mild fever and headaches.' },
    { storeCode: 'ALI', sku: 'HER-IMC-060', name: 'Immune Boost C', genericName: 'Ascorbic acid', strength: '250mg', category: 'Vitamins', price: 24.5, unitLabel: '60 gummies', stock: 54, imageUrl: '/uploads/products/HER-IMC-060.jpg', description: 'Vitamin C gummies with zinc for year-round immune support.' },
    { storeCode: 'CTY', sku: 'HER-LOR-030', name: 'Loradine 10mg', genericName: 'Loratadine', strength: '10mg', category: 'Medicines', price: 14.25, unitLabel: '30 tablets', stock: 42, rxRequired: true, imageUrl: '/uploads/products/HER-LOR-030.jpg', description: 'Non-drowsy allergy relief. Dispense against a valid prescription.' },
    { storeCode: 'ALI', sku: 'HER-LOR-030', name: 'Loradine 10mg', genericName: 'Loratadine', strength: '10mg', category: 'Medicines', price: 13.5, unitLabel: '30 tablets', stock: 0, rxRequired: true, published: true, imageUrl: '/uploads/products/HER-LOR-030.jpg', description: 'Non-drowsy allergy relief. Dispense against a valid prescription.' },
    { storeCode: 'HCP', sku: 'HER-LOR-030', name: 'Loradine 10mg', genericName: 'Loratadine', strength: '10mg', category: 'Medicines', price: 14.9, unitLabel: '30 tablets', stock: 18, rxRequired: true, imageUrl: '/uploads/products/HER-LOR-030.jpg', description: 'Non-drowsy allergy relief. Dispense against a valid prescription.' },
    { storeCode: 'CTY', sku: 'HER-YAK-020', name: 'Yakapsule 500mg', genericName: 'Paracetamol', strength: '500mg', category: 'Medicines', price: 17.9, unitLabel: '20 tablets', stock: 80, imageUrl: '/uploads/products/HER-YAK-020.jpg', description: 'Fast-acting relief for mild fever and headaches.' },
    { storeCode: 'HCP', sku: 'HER-GLU-050', name: 'Glucose Strips', genericName: 'Glucose oxidase strips', strength: 'N/A', category: 'Devices', price: 32.4, unitLabel: '50 count', stock: 6, imageUrl: '/uploads/products/HER-GLU-050.jpg', description: 'Blood glucose test strips.' },
    { storeCode: 'NEW', sku: 'HER-YAK-020', name: 'Yakapsule 500mg', genericName: 'Paracetamol', strength: '500mg', category: 'Medicines', price: 16.5, unitLabel: '20 tablets', stock: 60, imageUrl: '/uploads/products/HER-YAK-020.jpg', description: 'Fast-acting relief for mild fever and headaches.' },
    { storeCode: 'NEW', sku: 'HER-CAL-090', name: 'Calcium Care', genericName: 'Calcium carbonate', strength: '600mg', category: 'Supplements', price: 28, unitLabel: '90 tablets', stock: 40, imageUrl: '/uploads/products/HER-CAL-090.jpg', description: 'Calcium with vitamin D3 for bone strength.' },
  ]

  for (const product of products) {
    const storeId = stores[product.storeCode].id
    const created = await prisma.product.upsert({
      where: { storeId_sku: { storeId, sku: product.sku } },
      create: {
        storeId,
        sku: product.sku,
        name: product.name,
        brand: 'hera.',
        genericName: product.genericName,
        strength: product.strength,
        category: product.category,
        price: dec(product.price),
        unitLabel: product.unitLabel,
        stock: product.stock,
        batch: 'CC-26',
        expiry: '12/27',
        rxRequired: product.rxRequired ?? false,
        published: product.published ?? true,
        imageUrl: product.imageUrl,
        description: product.description,
      },
      update: {
        name: product.name,
        price: dec(product.price),
        stock: product.stock,
        published: product.published ?? true,
        rxRequired: product.rxRequired ?? false,
      },
    })
    const batchCount = await prisma.inventoryBatch.count({ where: { productId: created.id } })
    if (batchCount === 0 && product.stock > 0) {
      await prisma.inventoryBatch.create({
        data: {
          productId: created.id,
          storeId,
          batchNumber: 'CC-26',
          quantity: product.stock,
          expiry: '12/27',
        },
      })
    }
  }

  for (const code of DEMO_CODES) {
    const store = stores[code]
    const ruleCount = await prisma.chargeRule.count({ where: { storeId: store.id, kind: 'DELIVERY' } })
    if (ruleCount === 0) {
      await prisma.chargeRule.createMany({
        data: [
          { storeId: store.id, kind: 'DELIVERY', label: 'Standard delivery', mode: 'FIXED', amount: dec(code === 'CTY' ? 4 : 3.5), deliveryType: 'standard', active: true },
          { storeId: store.id, kind: 'DELIVERY', label: 'Express delivery', mode: 'FIXED', amount: dec(code === 'CTY' ? 7 : 6.5), deliveryType: 'express', active: true },
          { storeId: store.id, kind: 'DELIVERY', label: 'Store pickup', mode: 'FIXED', amount: dec(0), deliveryType: 'pickup', active: true },
        ],
      })
    }
    const optionCount = await prisma.storeDeliveryOption.count({ where: { storeId: store.id } })
    if (optionCount === 0) {
      await prisma.storeDeliveryOption.createMany({
        data: [
          { storeId: store.id, type: 'standard', label: 'Standard', available: true, fee: dec(code === 'CTY' ? 4 : 3.5), etaMinutes: 60, deliveryArea: 'Manhattan' },
          { storeId: store.id, type: 'express', label: 'Express', available: true, fee: dec(code === 'CTY' ? 7 : 6.5), etaMinutes: 30, deliveryArea: 'Manhattan' },
          { storeId: store.id, type: 'pickup', label: 'Pickup', available: true, fee: dec(0), etaMinutes: 20, deliveryArea: '' },
        ],
      })
    }
  }

  await prisma.setting.upsert({
    where: { id: 'default' },
    create: { id: 'default', mobileConfig: DEFAULT_MOBILE_CONFIG },
    update: {},
  })
  await prisma.promoCode.upsert({
    where: { code: 'HERA1' },
    create: { code: 'HERA1', label: 'Welcome discount', discount: dec(8.9), active: true },
    update: { active: true },
  })

  const addressCount = await prisma.customerAddress.count({ where: { customerId: michael.id } })
  if (addressCount === 0) {
    await prisma.customerAddress.createMany({
      data: [
        { customerId: michael.id, label: 'Home', line: '245 Park Ave, New York, NY', isDefault: true },
        { customerId: michael.id, label: 'Work', line: '350 5th Ave, New York, NY', isDefault: false },
      ],
    })
  }

  const customCount = await prisma.store.count({ where: { code: { notIn: [...DEMO_CODES] } } })
  console.log(`Seeded owner ava@hera.care / ${adminPassword}`)
  console.log(`Seeded NEW manager nina@hera.care / ${managerPassword} (NEW store only)`)
  console.log(`Preserved ${customCount} user-created store(s) outside demo codes ${DEMO_CODES.join(', ')}`)
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error)
    await prisma.$disconnect()
    process.exit(1)
  })
