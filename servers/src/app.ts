import { Hono } from "hono";
import { logger } from "hono/logger";
import { cors } from "hono/cors";
import { healthRoutes } from "./routes/health.js";

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
app.use(
  "*",
  cors({
    origin: ["http://localhost:3000"],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    allowHeaders: ["Content-Type", "Authorization"],
  }),
);

// ── Routes ──────────────────────────────────────────────
app.route("/api/health", healthRoutes);

// ── Fallback ────────────────────────────────────────────
app.notFound((c) =>
  c.json({ error: "Not Found", path: c.req.path }, 404),
);

app.onError((err, c) => {
  console.error(`[server] unhandled error: ${err.message}`, err);
  return c.json(
    { error: "Internal Server Error", message: err.message },
    500,
  );
});
