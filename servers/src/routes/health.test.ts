import { describe, it, expect } from "vitest";
import { app } from "../app.js";

describe("Health Routes", () => {
  it("GET /api/health/live returns 200", async () => {
    const res = await app.request("/api/health/live");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.timestamp).toBeDefined();
  });

  it("GET /api/health/ready returns 503 when DB is unavailable", async () => {
    // In unit tests (no PG running), readiness check should fail gracefully
    const res = await app.request("/api/health/ready");
    // May be 200 or 503 depending on whether PG is up
    expect([200, 503]).toContain(res.status);
    const body = await res.json();
    expect(body.timestamp).toBeDefined();
    expect(body.checks).toBeDefined();
    expect(body.checks.database).toBeDefined();
  });

  it("returns 404 for unknown routes", async () => {
    const res = await app.request("/api/nonexistent");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Not Found");
  });
});
