import { z } from "zod";

/**
 * Validated environment configuration.
 *
 * All env vars are validated at startup via Zod.
 * API keys are optional — only required in LIVE mode.
 */
const envSchema = z.object({
  // Execution mode (DEC-P05)
  EXECUTION_MODE: z
    .enum(["LIVE", "REPLAY"])
    .default("REPLAY"),

  // Database
  DATABASE_URL: z
    .string()
    .url()
    .default("postgresql://nolen:nolen_dev@localhost:5432/nolen_film"),

  // Server
  PORT: z.coerce.number().int().positive().default(3001),
  HOST: z.string().default("127.0.0.1"),
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),

  // Storage
  STORAGE_BASE_PATH: z.string().default("./storage"),

  // Provider API keys — required only in LIVE mode
  GEMINI_API_KEY: z.string().optional(),
  RUNWAY_API_KEY: z.string().optional(),
  FAL_API_KEY: z.string().optional(),

  // pg-boss
  PGBOSS_SCHEMA: z.string().default("pgboss"),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(2),
});

export type Env = z.infer<typeof envSchema>;

let cachedEnv: Env | null = null;

/**
 * Parse and cache environment variables.
 * Throws on invalid configuration — fail fast at startup.
 */
export function getEnv(): Env {
  if (cachedEnv) return cachedEnv;

  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error(
      "[config] Invalid environment variables:",
      result.error.flatten().fieldErrors,
    );
    throw new Error("Invalid environment configuration");
  }

  // Guard: LIVE mode requires provider keys
  if (result.data.EXECUTION_MODE === "LIVE") {
    const missing: string[] = [];
    if (!result.data.GEMINI_API_KEY) missing.push("GEMINI_API_KEY");
    // Runway and fal.ai are needed for I2V but warn, don't block boot
    if (missing.length > 0) {
      console.warn(
        `[config] LIVE mode active but missing keys: ${missing.join(", ")}`,
      );
    }
  }

  cachedEnv = result.data;
  return cachedEnv;
}

/** Reset cached env — for testing only. */
export function resetEnvCache(): void {
  cachedEnv = null;
}
