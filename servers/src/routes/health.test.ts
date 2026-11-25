const timestampMatcher: unknown = expect.any(String);
import { describe, it, expect, vi, beforeEach } from "vitest";
import { app } from "../app.js";

const { execute, checkWritable } = vi.hoisted(() => ({
  execute: vi.fn(),
  checkWritable: vi.fn(),
}));
vi.mock("../db/index.js", () => ({ db: { execute } }));
vi.mock("../lib/storage.js", () => ({ storage: { checkWritable } }));

describe("Health Routes", () => {
  beforeEach(() => {
    execute.mockReset();
    checkWritable.mockReset();
    checkWritable.mockResolvedValue(undefined);
  });
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

  it("GET /api/health/ready returns 503 when storage is unwritable (CS-AT-01)", async () => {
    execute.mockResolvedValue([{ value: 1 }]);
    checkWritable.mockRejectedValue(new Error("EACCES: read-only storage"));
    const res = await app.request("http://127.0.0.1:3000/api/health/ready");
    expect(res.status).toBe(503);
    const body: unknown = await res.json();
    expect(body).toEqual({
      status: "not_ready",
      timestamp: timestampMatcher,
      checks: { database: "connected", storage: "unwritable: EACCES: read-only storage" },
    });
  });

  it("GET /api/health/ready returns 200 when DB and storage checks succeed", async () => {
    execute.mockResolvedValue([{ value: 1 }]);
    const res = await app.request("http://127.0.0.1:3000/api/health/ready");
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    expect(body).toEqual({ status: "ready", timestamp: timestampMatcher, checks: { database: "connected", storage: "writable" } });
    expect(execute).toHaveBeenCalledOnce();
    expect(checkWritable).toHaveBeenCalledOnce();
  });

  it("returns 404 for unknown routes", async () => {
    const res = await app.request("http://127.0.0.1:3000/api/nonexistent");
    expect(res.status).toBe(404);
    const body: unknown = await res.json();
    expect(body).toEqual({ error: {code:'NOT_FOUND',message:'Route not found',requestId:timestampMatcher} });
  });
});
