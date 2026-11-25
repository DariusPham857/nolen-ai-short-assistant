import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { validateStaticReferenceImage } from './media-validation.js';

function genMedia(args: string[]): Buffer {
  return execFileSync('ffmpeg', ['-v', 'error', ...args], { maxBuffer: 20 * 1024 * 1024 });
}

/**
 * Real FFprobe/FFmpeg stdin validation tests (GI-AT-05, GI-AT-12).
 * Must NEVER conditionally skip when ffmpeg/ffprobe is missing.
 */
describe('validateStaticReferenceImage (real ffprobe/ffmpeg stdin)', () => {
  it('accepts valid static PNG, JPEG, and WebP within bounds', async () => {
    const png = genMedia(['-f', 'lavfi', '-i', 'color=c=red:s=320x320:d=0.04', '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1']);
    const jpg = genMedia(['-f', 'lavfi', '-i', 'color=c=blue:s=320x320:d=0.04', '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1']);
    const webp = genMedia(['-f', 'lavfi', '-i', 'color=c=green:s=320x320:d=0.04', '-frames:v', '1', '-f', 'webp', 'pipe:1']);

    await expect(validateStaticReferenceImage(png)).resolves.toEqual({ mimeType: 'image/png', width: 320, height: 320 });
    await expect(validateStaticReferenceImage(jpg)).resolves.toEqual({ mimeType: 'image/jpeg', width: 320, height: 320 });
    await expect(validateStaticReferenceImage(webp)).resolves.toEqual({ mimeType: 'image/webp', width: 320, height: 320 });
  });

  it('rejects below-min dimensions, above-max pixels, animated WebP/APNG, and corrupt tail', async () => {
    const tooSmall = genMedia(['-f', 'lavfi', '-i', 'color=c=red:s=298x300:d=0.04', '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1']);
    const tooWide = genMedia(['-f', 'lavfi', '-i', 'color=c=black:s=4098x300:d=0.04', '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1']);
    const tooBig = genMedia(['-f', 'lavfi', '-i', 'color=c=black:s=4098x4098:d=0.04', '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1']);
    const animWebp = genMedia(['-f', 'lavfi', '-i', 'testsrc=s=320x320:d=0.2:r=10', '-frames:v', '2', '-f', 'webp', 'pipe:1']);
    const animApng = genMedia(['-f', 'lavfi', '-i', 'testsrc=s=320x320:d=0.2:r=10', '-frames:v', '2', '-f', 'apng', 'pipe:1']);
    const validPng = genMedia(['-f', 'lavfi', '-i', 'color=c=red:s=320x320:d=0.04', '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1']);
    const corruptPng = Buffer.concat([validPng.subarray(0, 40), Buffer.from('corrupt-payload')]);
    const spoofedText = Buffer.from('<html>not a png</html>');

    for (const bad of [tooSmall, tooWide, tooBig, animWebp, animApng, corruptPng, spoofedText]) {
      await expect(validateStaticReferenceImage(bad)).rejects.toMatchObject({
        status: 422,
        code: 'REFERENCE_IMAGE_UNSAFE',
      });
    }
  });

  it('rejects ffprobe/ffmpeg output exceeding maxOutputBytes', async () => {
    const png = genMedia(['-f', 'lavfi', '-i', 'color=c=red:s=320x320:d=0.04', '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1']);
    await expect(
      validateStaticReferenceImage(png, { maxOutputBytes: 16 }),
    ).rejects.toMatchObject({ status: 422, code: 'REFERENCE_IMAGE_UNSAFE' });
  });
});
