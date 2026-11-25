import { existsSync, readFileSync } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixtureManifestSchema, type FixtureEntry, type FixtureManifest } from './manifest-schema.js';

export interface ResolvedFixture extends FixtureEntry {
  buffer: Buffer;
  resolvedPath: string;
}

const currentDir = path.dirname(fileURLToPath(import.meta.url));

const PACK_VERSION_REGEX = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function assertValidPackVersion(packVersion: string): void {
  if (
    !packVersion ||
    !PACK_VERSION_REGEX.test(packVersion) ||
    packVersion.includes('..') ||
    packVersion.includes('/') ||
    packVersion.includes('\\')
  ) {
    throw new Error(`PATH_TRAVERSAL_BLOCKED: Invalid fixturePackVersion '${packVersion}'`);
  }
}

/**
 * Resolves directory containing fixture pack files.
 * Checks both development source (src/../fixtures) and production build (dist/fixtures).
 */
export function getFixturePackDir(packVersion: string): string {
  assertValidPackVersion(packVersion);

  // Option 1: Development root or repository root
  const candidates = [
    path.resolve(currentDir, '..', '..', 'fixtures', `replay-pack-${packVersion}`),
    path.resolve(currentDir, '..', 'fixtures', `replay-pack-${packVersion}`),
    path.resolve(process.cwd(), 'fixtures', `replay-pack-${packVersion}`),
    path.resolve(process.cwd(), 'servers', 'fixtures', `replay-pack-${packVersion}`),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  // Fallback to primary expected path
  return candidates[0];
}

/**
 * Loads and validates fixture pack manifest against Zod schema.
 */
export function loadFixtureManifest(packVersion: string, customPackDir?: string): FixtureManifest {
  assertValidPackVersion(packVersion);
  const packDir = customPackDir ?? getFixturePackDir(packVersion);
  const manifestPath = path.resolve(packDir, 'manifest.json');

  if (!existsSync(manifestPath)) {
    throw new Error(`REPLAY_FIXTURE_MANIFEST_NOT_FOUND: Manifest not found at ${manifestPath}`);
  }

  const raw = readFileSync(manifestPath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: unknown) {
    throw new Error(`REPLAY_FIXTURE_MANIFEST_INVALID: JSON parse error: ${err instanceof Error ? err.message : String(err)}`);
  }

  const manifest = fixtureManifestSchema.parse(parsed);
  if (manifest.version !== packVersion) {
    throw new Error(`FIXTURE_PACK_VERSION_MISMATCH: Manifest version '${manifest.version}' does not match requested packVersion '${packVersion}'`);
  }

  return manifest;
}

/**
 * Resolves a fixture from the specified pack with strict path containment and SHA-256 integrity verification.
 * Blocks:
 * - Lexical directory traversal (..)
 * - Absolute paths (/etc/passwd, C:\...)
 * - Symlinks escaping the fixture root directory (including sibling directories with common prefix)
 * - File hash corruption (mismatch with manifest SHA-256)
 */
export async function resolveFixture(
  packVersion: string,
  fixtureId: string,
  options?: { customPackDir?: string },
): Promise<ResolvedFixture> {
  assertValidPackVersion(packVersion);
  const packDir = options?.customPackDir ?? getFixturePackDir(packVersion);
  if (!existsSync(packDir)) {
    throw new Error(`REPLAY_FIXTURE_PACK_NOT_FOUND: Fixture pack directory not found: ${packDir}`);
  }

  const manifest = loadFixtureManifest(packVersion, packDir);
  const entry = manifest.fixtures.find(f => f.fixtureId === fixtureId);
  if (!entry) {
    throw new Error(`REPLAY_FIXTURE_NOT_FOUND: Fixture '${fixtureId}' not found in pack '${packVersion}'`);
  }

  const realRoot = await realpath(packDir);
  const targetPath = path.resolve(realRoot, entry.relPath);

  // 1. Lexical containment check
  const relLexical = path.relative(realRoot, targetPath);
  if (relLexical.startsWith('..') || path.isAbsolute(relLexical)) {
    throw new Error(`PATH_TRAVERSAL_BLOCKED: Path '${entry.relPath}' escapes fixture root directory lexically`);
  }

  if (!existsSync(targetPath)) {
    throw new Error(`REPLAY_FIXTURE_FILE_MISSING: Fixture file not found: ${targetPath}`);
  }

  // 2. Realpath containment check (resolves symlinks)
  const realTarget = await realpath(targetPath);
  const relReal = path.relative(realRoot, realTarget);
  if (relReal.startsWith('..') || path.isAbsolute(relReal)) {
    throw new Error(`PATH_TRAVERSAL_BLOCKED: Symlink target '${realTarget}' escapes fixture root directory`);
  }

  // 3. Read file and verify SHA-256
  const buffer = await readFile(realTarget);
  const actualHash = createHash('sha256').update(buffer).digest('hex');

  if (actualHash !== entry.sha256) {
    throw new Error(`REPLAY_FIXTURE_CORRUPT: SHA-256 mismatch for '${fixtureId}'. Expected ${entry.sha256}, got ${actualHash}`);
  }

  if (buffer.length !== entry.byteSize) {
    throw new Error(`REPLAY_FIXTURE_CORRUPT: Byte size mismatch for '${fixtureId}'. Expected ${entry.byteSize}, got ${buffer.length}`);
  }

  return {
    ...entry,
    buffer,
    resolvedPath: realTarget,
  };
}
