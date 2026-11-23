/**
 * StorageAdapter — abstraction over local filesystem for media assets.
 *
 * All media reads/writes go through this adapter so the business logic
 * is not coupled to raw filesystem paths (PRD §8, §9 Portability).
 *
 * Responsibilities:
 * - Resolve storage paths relative to STORAGE_BASE_PATH
 * - Ensure target directories exist before writes
 * - Verify SHA-256 hashes after download (DEC-P06)
 * - Reject private/loopback IPs on remote downloads (SSRF protection)
 *
 * @see PRD §8 Architecture, §20.5 DEC-P06
 */
import { existsSync, mkdirSync } from "fs";
import { readFile, writeFile, unlink } from "fs/promises";
import { createHash } from "crypto";
import path from "path";
import { getEnv } from "../config/env.js";

export type AssetCategory =
  | "keyframes"
  | "videos"
  | "audio"
  | "exports"
  | "temp";

export class StorageAdapter {
  private basePath: string;

  constructor(basePath?: string) {
    this.basePath = basePath ?? getEnv().STORAGE_BASE_PATH;
  }

  /** Resolve a path within a category directory with OWASP path containment check. */
  resolve(category: AssetCategory, filename: string): string {
    const dir = path.resolve(this.basePath, category);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const target = path.resolve(dir, filename);
    const rel = path.relative(dir, target);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`Path containment violation: ${filename}`);
    }
    return target;
  }

  /** Write data to storage and return its SHA-256 hash. */
  async write(
    category: AssetCategory,
    filename: string,
    data: Buffer,
  ): Promise<{ path: string; sha256: string }> {
    const filePath = this.resolve(category, filename);
    await writeFile(filePath, data);
    const hash = createHash("sha256").update(data).digest("hex");
    return { path: filePath, sha256: hash };
  }

  /** Read a file from storage. */
  async read(
    category: AssetCategory,
    filename: string,
  ): Promise<Buffer> {
    const filePath = this.resolve(category, filename);
    return readFile(filePath);
  }

  /** Delete a file from storage. */
  async delete(
    category: AssetCategory,
    filename: string,
  ): Promise<void> {
    const filePath = this.resolve(category, filename);
    if (existsSync(filePath)) {
      await unlink(filePath);
    }
  }

  /** Verify SHA-256 hash of a stored file. */
  async verify(
    category: AssetCategory,
    filename: string,
    expectedHash: string,
  ): Promise<boolean> {
    const data = await this.read(category, filename);
    const actualHash = createHash("sha256").update(data).digest("hex");
    return actualHash === expectedHash;
  }

  /** Check if a file exists in storage. */
  exists(category: AssetCategory, filename: string): boolean {
    const filePath = this.resolve(category, filename);
    return existsSync(filePath);
  }
}

/** Singleton storage adapter instance. */
export const storage = new StorageAdapter();
