import "dotenv/config";
import { prisma } from "./src/lib/prisma.js";

const stores = await prisma.store.findMany({
  select: {
    id: true,
    name: true,
    address: true,
    city: true,
    country: true,
    maxDeliveryDistanceKm: true,
    mapLat: true,
    mapLng: true
  }
});

console.log(JSON.stringify(stores, null, 2));
await prisma.$disconnect();
