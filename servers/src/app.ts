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
import { installBoundary } from './http/boundary.js';
import { createStoryApi } from './http/story-api.js';
export const app = new Hono();
installBoundary(app);

// ── Middleware ───────────────────────────────────────────
app.use("*", logger());
app.route("/", createFilmApi());
app.route("/", createStoryApi());

// ── Routes ──────────────────────────────────────────────
app.route("/api/health", healthRoutes);
