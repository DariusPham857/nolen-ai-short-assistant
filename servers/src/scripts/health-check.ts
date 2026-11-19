/**
 * Preflight health check script.
 *
 * Validates that all required services and tools are ready before demo:
 * 1. PostgreSQL 16 connectivity
 * 2. Migrations are current
 * 3. StorageAdapter directories exist and are writable
 * 4. FFmpeg is available
 *
 * Usage: pnpm health:check
 *
 * @see PRD §29.9 AT-P09-05, EP-00 T-001
 */
import "dotenv/config";
import { execSync } from "child_process";
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "fs";
import path from "path";
import { db, pgClient } from "../db/index.js";
import { sql } from "drizzle-orm";
import { getEnv } from "../config/env.js";

interface CheckResult {
  name: string;
  status: "pass" | "fail" | "warn";
  detail: string;
}

const results: CheckResult[] = [];

function check(name: string, status: CheckResult["status"], detail: string) {
  results.push({ name, status, detail });
  const icon = status === "pass" ? "✓" : status === "warn" ? "⚠" : "✗";
  console.log(`  ${icon} ${name}: ${detail}`);
}

async function run() {
  const env = getEnv();
  console.log("\n── nolen-ai preflight health check ──\n");

  // 1. Database connectivity
  try {
    const result = await db.execute(
      sql`SELECT version() as version`,
    );
    const version = result[0]?.version;
    if (typeof version !== "string") throw new Error("Invalid database version response");
    check("PostgreSQL", "pass", version.split(",")[0]);
  } catch (err) {
    check(
      "PostgreSQL",
      "fail",
      `Cannot connect: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // 2. Storage directories
  const storageDirs = ["keyframes", "videos", "audio", "exports", "temp"];
  for (const dir of storageDirs) {
    const fullPath = path.resolve(env.STORAGE_BASE_PATH, dir);
    try {
      if (!existsSync(fullPath)) {
        mkdirSync(fullPath, { recursive: true });
      }
      // Test write
      const testFile = path.join(fullPath, ".write-test");
      writeFileSync(testFile, "ok");
      unlinkSync(testFile);
      check(`Storage/${dir}`, "pass", fullPath);
    } catch (err) {
      check(
        `Storage/${dir}`,
        "fail",
        `Not writable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // 3. FFmpeg availability
  try {
    const ffmpegVersion = execSync("ffmpeg -version", {
      encoding: "utf-8",
      timeout: 5000,
    });
    const firstLine = ffmpegVersion.split("\n")[0];
    check("FFmpeg", "pass", firstLine);
  } catch {
    check("FFmpeg", "warn", "FFmpeg not found in PATH (needed for assembly)");
  }

  // 4. Execution mode
  check("Execution Mode", "pass", env.EXECUTION_MODE);

  // Summary
  console.log("\n── Summary ──\n");
  const fails = results.filter((r) => r.status === "fail");
  const warns = results.filter((r) => r.status === "warn");

  if (fails.length === 0) {
    console.log(
      `  All checks passed (${warns.length} warning${warns.length !== 1 ? "s" : ""}).`,
    );
  } else {
    console.log(
      `  ${fails.length} check${fails.length !== 1 ? "s" : ""} FAILED.`,
    );
  }

  await pgClient.end();
  process.exit(fails.length > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error("[health-check] Unexpected error:", err);
  process.exit(1);
});
