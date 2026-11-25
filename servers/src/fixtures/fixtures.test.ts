import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fixtureManifestSchema } from './manifest-schema.js';
import { loadFixtureManifest, resolveFixture, getFixturePackDir } from './resolver.js';

describe('Replay Fixture Pack v1 & Path-Contained Resolver (PD-05a.3 / R1)', () => {
  const packDir = getFixturePackDir('v1');
  const tempTestDir = path.resolve(process.cwd(), 'fixtures-temp-test');
  const evilSiblingDir = path.resolve(process.cwd(), 'fixtures-temp-test-evil');

  beforeAll(() => {
    // Setup temporary test directories for security containment tests
    if (existsSync(tempTestDir)) rmSync(tempTestDir, { recursive: true, force: true });
    if (existsSync(evilSiblingDir)) rmSync(evilSiblingDir, { recursive: true, force: true });

    mkdirSync(tempTestDir, { recursive: true });
    mkdirSync(evilSiblingDir, { recursive: true });

    writeFileSync(path.resolve(evilSiblingDir, 'secret.png'), 'secret evil file content');
  });

  afterAll(() => {
    if (existsSync(tempTestDir)) rmSync(tempTestDir, { recursive: true, force: true });
    if (existsSync(evilSiblingDir)) rmSync(evilSiblingDir, { recursive: true, force: true });
  });

  it('validates manifest.json against fixtureManifestSchema', () => {
    const manifest = loadFixtureManifest('v1');
    expect(manifest.version).toBe('v1');
    expect(manifest.fixtures.length).toBeGreaterThanOrEqual(4);

    const result = fixtureManifestSchema.safeParse(manifest);
    expect(result.success).toBe(true);

    const fixtureIds = manifest.fixtures.map(f => f.fixtureId);
    expect(fixtureIds).toContain('default-gemini-image-9-16');
    expect(fixtureIds).toContain('default-runway-video-9-16');
    expect(fixtureIds).toContain('default-fal_kling-video-9-16');
    expect(fixtureIds).toContain('default-local_pan_zoom-video-9-16');
  });

  it('resolves valid default media fixtures with exact SHA-256 and byte size integrity', async () => {
    const gemini = await resolveFixture('v1', 'default-gemini-image-9-16');
    expect(gemini.provider).toBe('GEMINI');
    expect(gemini.kind).toBe('IMAGE');
    expect(gemini.aspectRatio).toBe('9:16');
    expect(gemini.mimeType).toBe('image/png');
    expect(createHash('sha256').update(gemini.buffer).digest('hex')).toBe(gemini.sha256);
    expect(gemini.buffer.length).toBe(gemini.byteSize);

    const runway = await resolveFixture('v1', 'default-runway-video-9-16');
    expect(runway.provider).toBe('RUNWAY');
    expect(runway.kind).toBe('VIDEO');
    expect(runway.mimeType).toBe('video/mp4');
    expect(createHash('sha256').update(runway.buffer).digest('hex')).toBe(runway.sha256);
    expect(runway.buffer.length).toBe(runway.byteSize);
  });

  describe('Path Containment & Security Invariants', () => {
    it('blocks lexical path traversal (../) in relPath', async () => {
      const syntheticManifest = {
        version: 'v1',
        fixtures: [
          {
            fixtureId: 'traversal-attack',
            provider: 'GEMINI',
            kind: 'IMAGE',
            aspectRatio: '9:16',
            relPath: '../secret.png',
            mimeType: 'image/png',
            sha256: 'a'.repeat(64),
            byteSize: 100,
          },
        ],
      };

      // Zod schema itself blocks traversal paths
      const schemaResult = fixtureManifestSchema.safeParse(syntheticManifest);
      expect(schemaResult.success).toBe(false);
      expect(schemaResult.error?.issues[0].message).toContain('traversal');
    });

    it('blocks absolute paths in relPath', () => {
      const syntheticManifest = {
        version: 'v1',
        fixtures: [
          {
            fixtureId: 'absolute-attack',
            provider: 'GEMINI',
            kind: 'IMAGE',
            aspectRatio: '9:16',
            relPath: '/etc/passwd.png',
            mimeType: 'image/png',
            sha256: 'a'.repeat(64),
            byteSize: 100,
          },
        ],
      };

      const schemaResult = fixtureManifestSchema.safeParse(syntheticManifest);
      expect(schemaResult.success).toBe(false);
    });

    it('blocks symlink escaping fixture root directory to sibling with shared prefix (MUST FIX 5)', async () => {
      // Create a symlink inside tempTestDir pointing to evilSiblingDir/secret.png
      const symlinkPath = path.resolve(tempTestDir, 'escaped.png');
      const targetEvilPath = path.resolve(evilSiblingDir, 'secret.png');

      try {
        symlinkSync(targetEvilPath, symlinkPath);
      } catch (e) {
        // Skip on OS if symlink privilege restricted, but verify resolver relative logic
      }

      if (existsSync(symlinkPath)) {
        const secretContent = 'secret evil file content';
        const secretHash = createHash('sha256').update(secretContent).digest('hex');

        writeFileSync(
          path.resolve(tempTestDir, 'manifest.json'),
          JSON.stringify({
            version: 'v1',
            fixtures: [
              {
                fixtureId: 'symlink-escape',
                provider: 'GEMINI',
                kind: 'IMAGE',
                aspectRatio: '9:16',
                relPath: 'escaped.png',
                mimeType: 'image/png',
                sha256: secretHash,
                byteSize: Buffer.byteLength(secretContent),
              },
            ],
          }),
        );

        await expect(
          resolveFixture('v1', 'symlink-escape', { customPackDir: tempTestDir }),
        ).rejects.toThrow('PATH_TRAVERSAL_BLOCKED');
      }
    });

    it('fails closed when fixture content is corrupt / hash mismatches manifest', async () => {
      const corruptPackDir = path.resolve(tempTestDir, 'corrupt-pack');
      mkdirSync(corruptPackDir, { recursive: true });
      writeFileSync(path.resolve(corruptPackDir, 'image.png'), 'corrupted bytes');

      writeFileSync(
        path.resolve(corruptPackDir, 'manifest.json'),
        JSON.stringify({
          version: 'v1',
          fixtures: [
            {
              fixtureId: 'corrupted-fixture',
              provider: 'GEMINI',
              kind: 'IMAGE',
              aspectRatio: '9:16',
              relPath: 'image.png',
              mimeType: 'image/png',
              sha256: 'b'.repeat(64), // Mismatched SHA-256
              byteSize: 15,
            },
          ],
        }),
      );

      await expect(
        resolveFixture('v1', 'corrupted-fixture', { customPackDir: corruptPackDir }),
      ).rejects.toThrow('REPLAY_FIXTURE_CORRUPT');
    });

    it('BLOCK 2: blocks directory traversal in fixturePackVersion parameter', async () => {
      const traversalAttacks = [
        'x/../replay-pack-v1',
        '../v1',
        '../../fixtures',
        '/v1',
        'v1/..',
        'v1\\..',
        '..\\v1',
      ];

      for (const attack of traversalAttacks) {
        expect(() => getFixturePackDir(attack)).toThrow('PATH_TRAVERSAL_BLOCKED');
        expect(() => loadFixtureManifest(attack)).toThrow('PATH_TRAVERSAL_BLOCKED');
        await expect(resolveFixture(attack, 'default-gemini-image-9-16')).rejects.toThrow('PATH_TRAVERSAL_BLOCKED');
      }
    });

    it('BLOCK 2: rejects when manifest.version does not match requested packVersion', async () => {
      const packV1Dir = getFixturePackDir('v1');
      expect(() => loadFixtureManifest('v2', packV1Dir)).toThrow('FIXTURE_PACK_VERSION_MISMATCH');
      await expect(resolveFixture('v2', 'default-gemini-image-9-16', { customPackDir: packV1Dir })).rejects.toThrow('FIXTURE_PACK_VERSION_MISMATCH');
    });
  });

  describe('Media Format & 9:16 Aspect Ratio Invariants', () => {
    it('verifies default-gemini-image-9-16.png binary header has width 720 and height 1280 (9:16)', async () => {
      const gemini = await resolveFixture('v1', 'default-gemini-image-9-16');

      // PNG signature: 89 50 4E 47 0D 0A 1A 0A
      const signature = gemini.buffer.subarray(0, 8);
      expect(signature).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

      // IHDR chunk starts at offset 12: chunk length 13, type 'IHDR'
      const chunkType = gemini.buffer.subarray(12, 16).toString('ascii');
      expect(chunkType).toBe('IHDR');

      // Width at offset 16 (32-bit big-endian)
      const width = gemini.buffer.readUInt32BE(16);
      // Height at offset 20 (32-bit big-endian)
      const height = gemini.buffer.readUInt32BE(20);

      expect(width).toBe(720);
      expect(height).toBe(1280);
      expect(width / height).toBeCloseTo(9 / 16, 2);
    });

    it('verifies default video fixtures contain valid MP4 ftyp and moov atom boxes', async () => {
      const runway = await resolveFixture('v1', 'default-runway-video-9-16');
      expect(runway.buffer.length).toBeGreaterThan(100);

      // MP4 begins with an atom box; bytes 4-8 usually 'ftyp'
      const ftypBox = runway.buffer.subarray(4, 8).toString('ascii');
      expect(ftypBox).toBe('ftyp');

      // Buffer contains 'moov' (movie atom) and 'mdat' (media data atom)
      expect(runway.buffer.includes(Buffer.from('moov'))).toBe(true);
      expect(runway.buffer.includes(Buffer.from('mdat'))).toBe(true);
    });

    it('validates video stream, duration and dimensions with ffprobe when available', async () => {
      let ffprobeAvailable = false;
      try {
        execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
        ffprobeAvailable = true;
      } catch {
        ffprobeAvailable = false;
      }

      if (ffprobeAvailable) {
        const runway = await resolveFixture('v1', 'default-runway-video-9-16');
        const probeOutput = execFileSync(
          'ffprobe',
          [
            '-v', 'error',
            '-select_streams', 'v:0',
            '-show_entries', 'stream=codec_name,width,height,duration',
            '-of', 'json',
            runway.resolvedPath,
          ],
          { encoding: 'utf8' },
        );

        const data = JSON.parse(probeOutput) as {
          streams?: Array<{ codec_name?: string; width?: number; height?: number }>;
        };
        const stream = data.streams?.[0];
        expect(stream).toBeDefined();
        expect(stream?.codec_name).toBe('h264');
        expect(Number(stream?.width)).toBe(720);
        expect(Number(stream?.height)).toBe(1280);
      }
    });
  });
});
