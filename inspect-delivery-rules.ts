import "dotenv/config";
import { prisma } from "./src/lib/prisma.js";

const main = async () => {
  const stores = await prisma.store.findMany({
    select: {
      id: true,
      name: true,
      city: true,
      maxDeliveryDistanceKm: true,
      chargeRules: {
        where: { kind: "DELIVERY" },
        orderBy: [
          { deliveryType: "asc" },
          { minDistanceKm: "asc" }
        ],
        select: {
          id: true,
          label: true,
          deliveryType: true,
          minDistanceKm: true,
          maxDistanceKm: true,
          amount: true,
          perKmRate: true,
          active: true
        }
      }
    }
  });

  console.log(JSON.stringify(stores, null, 2));
};

main().finally(() => prisma.$disconnect());
