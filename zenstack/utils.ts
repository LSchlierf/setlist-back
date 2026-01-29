import { ZenStackClient } from "@zenstackhq/orm";
import { schema } from "./schema.ts";
import { PostgresDialect } from "@zenstackhq/orm/dialects/postgres";
import { Pool } from "pg";
import dotenv from "dotenv";

dotenv.config();

export function createZenStackClient() {
  return new ZenStackClient(schema, {
    dialect: new PostgresDialect({
      pool: new Pool({
        connectionString: process.env.DBURL,
      }),
    }),
  });
}
