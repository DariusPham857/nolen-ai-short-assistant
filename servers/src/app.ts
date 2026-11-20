import { Hono } from "hono";
import { logger } from "hono/logger";
import { healthRoutes } from "./routes/health.js";
import { createFilmApi } from "./http/film-api.js";

/**
 * Root Hono application.
 *
 * Route groups are mounted here as the backend grows:
 *   /api/health  — liveness & readiness probes
 *   /api/films   — film CRUD (EP-01, future)
 *   /api/shots   — shot management (EP-01, future)
 *   /api/ledger  — cost ledger queries (EP-02, future)
 */
export const app = new Hono();

// ── Middleware ───────────────────────────────────────────
app.use("*", logger());
app.route("/", createFilmApi());

// ── Routes ──────────────────────────────────────────────
app.route("/api/health", healthRoutes);

// ── Fallback ────────────────────────────────────────────
app.notFound((c) =>
  c.json({ error: "Not Found", path: c.req.path }, 404),
);

app.onError((err, c) => {
  console.error('[server] unhandled request failure');
  return c.json(
    { error: { code: "INTERNAL_ERROR", message: "Request failed" } },
    500,
  );
});
