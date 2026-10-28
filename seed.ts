import { createZenStackClient } from "./zenstack/utils.ts";

import dotenv from "dotenv";
import { testuserCleanup } from "./utils/cleanup.ts";

dotenv.config({ quiet: true });

async function main() {
  console.log("🌱 Seeding database...");

  const db = createZenStackClient(process.env.DBURL!);

  const testuser = {
      id: "testuser",
      name: "testuser",
      passsalt: "ff00ce2b1c1bdab8e81dddf60d36fc7a",
      passhash:
        "ee24e745abffdef45d04364c1238a1b5134f32e592165e53a2a37eda4587feb2a3ea0ce2a38ed6c8fec07a709f7d5f3217826c417be6073c98cb566df59d9737",
      // password is 'password'
    }

  await db.band.upsert({
    where: {
      id: "testuser",
    },
    create: testuser,
    update: testuser,
  });

  await testuserCleanup(db);

  console.log("🌱 Seed complete.");
}

main().then(() => {
  process.exit(0);
});
