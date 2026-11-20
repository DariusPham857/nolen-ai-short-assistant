const timestampMatcher: unknown = expect.any(String);
import { afterAll, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { app } from "../app.js";
import { db, pgClient } from "../db/index.js";

afterAll(async () => { await pgClient.end(); });

it("connects to real PostgreSQL 16 and reports ready", async () => {
  const rows = await db.execute(sql`SHOW server_version_num`);
  const version = Number(rows[0]?.server_version_num);
  expect(version).toBeGreaterThanOrEqual(160000);
  expect(version).toBeLessThan(170000);
  const response = await app.request("http://127.0.0.1:3000/api/health/ready");
  expect(response.status).toBe(200);
  const body: unknown = await response.json();
  expect(body).toEqual({ status: "ready", timestamp: timestampMatcher, checks: { database: "connected" } });
});

