import { ZenStackClient } from "@zenstackhq/orm";
import { schema } from "./schema.ts";
import { PostgresDialect } from "@zenstackhq/orm/dialects/postgres";
import { Pool } from "pg";

export function createZenStackClient(connectionString: string) {
  return new ZenStackClient(schema, {
    dialect: new PostgresDialect({
      pool: new Pool({
        connectionString
      }),
    }),
  });
}
