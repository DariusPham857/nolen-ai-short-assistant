import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index.js";

/**
 * Database client singleton.
 *
 * Uses postgres.js driver with Drizzle ORM.
 * Connection URL is read from DATABASE_URL env var.
 *
 * Note: In production, connection pooling settings should be tuned.
 * For localhost demo topology (DEC-P05), defaults are sufficient.
 */
const connectionString =
  process.env.DATABASE_URL ??
  "postgresql://nolen:nolen_dev@localhost:5432/nolen_film";

/** Raw postgres.js client — used for migrations and raw queries. */
export const pgClient = postgres(connectionString, {
  max: 10,
  idle_timeout: 20,
  connect_timeout: 10,
});

/** Drizzle ORM instance with schema type safety. */
export const db = drizzle(pgClient, { schema });
