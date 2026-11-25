import { Hono } from "hono";
import { db } from "../db/index.js";
import { sql } from "drizzle-orm";
import { storage } from "../lib/storage.js";

/**
 * Health check routes (PRD §9, AT-P09-05).
 *
 * GET /api/health/live   — liveness probe (always 200 if process is up)
 * GET /api/health/ready  — readiness probe (checks DB connectivity and writable storage)
 */
export const healthRoutes = new Hono();

healthRoutes.get("/live", (c) => {
  return c.json({
    status: "ok",
    timestamp: new Date().toISOString(),
  });
});

healthRoutes.get("/ready", async (c) => {
  try {
    // Verify DB connection with a simple query
    await db.execute(sql`SELECT 1`);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown error";
    return c.json(
      {
        status: "not_ready",
        timestamp: new Date().toISOString(),
        checks: {
          database: `disconnected: ${message}`,
        },
      },
      503,
    );
  }

  try {
    await storage.checkWritable();
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown error";
    return c.json(
      {
        status: "not_ready",
        timestamp: new Date().toISOString(),
        checks: {
          database: "connected",
          storage: `unwritable: ${message}`,
        },
      },
      503,
    );
  }

  return c.json({
    status: "ready",
    timestamp: new Date().toISOString(),
    checks: {
      database: "connected",
      storage: "writable",
    },
  });
});
