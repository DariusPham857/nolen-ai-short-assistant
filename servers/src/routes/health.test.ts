const timestampMatcher: unknown = expect.any(String);
import { describe, it, expect, vi, beforeEach } from "vitest";
import { app } from "../app.js";

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("../db/index.js", () => ({ db: { execute } }));

describe("Health Routes", () => {
  beforeEach(() => { execute.mockReset(); });
  it("GET /api/health/live returns 200", async () => {
    const res = await app.request("http://127.0.0.1:3000/api/health/live");
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    expect(body).toEqual({ status: "ok", timestamp: timestampMatcher });
  });

  it("GET /api/health/ready returns 503 when DB is unavailable", async () => {
    execute.mockRejectedValue(new Error("fixture unavailable"));
    const res = await app.request("http://127.0.0.1:3000/api/health/ready");
    expect(res.status).toBe(503);
    const body: unknown = await res.json();
    expect(body).toEqual({ status: "not_ready", timestamp: timestampMatcher, checks: { database: "disconnected: fixture unavailable" } });
  });

  it("GET /api/health/ready returns 200 when DB query succeeds", async () => {
    execute.mockResolvedValue([{ value: 1 }]);
    const res = await app.request("http://127.0.0.1:3000/api/health/ready");
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    expect(body).toEqual({ status: "ready", timestamp: timestampMatcher, checks: { database: "connected" } });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("returns 404 for unknown routes", async () => {
    const res = await app.request("http://127.0.0.1:3000/api/nonexistent");
    expect(res.status).toBe(404);
    const body: unknown = await res.json();
    expect(body).toEqual({ error: "Not Found", path: "/api/nonexistent" });
  });
});

