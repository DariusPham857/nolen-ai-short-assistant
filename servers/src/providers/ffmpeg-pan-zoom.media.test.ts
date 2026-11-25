import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StorageAdapter } from '../lib/storage.js';
import { probeRenderedMp4, renderLocalPanZoomMp4 } from './ffmpeg-pan-zoom.js';

function genPng(size: string): Buffer {
  return execFileSync(
    'ffmpeg',
    ['-v', 'error', '-f', 'lavfi', '-i', `testsrc=s=${size}:d=0.04`, '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1'],
    { maxBuffer: 10 * 1024 * 1024 },
  );
}

/**
 * Real FFmpeg/FFprobe LP-001 render tests (LP-AT-01, LP-AT-03, LP-AT-08).
 * Must NEVER skip when ffmpeg/ffprobe is unavailable; runs in Docker via `pnpm test:media`.
 */
describe('renderLocalPanZoomMp4 (real ffmpeg/ffprobe)', () => {
  let tmpRoot: string;
  let storage: StorageAdapter;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nolen-lp02-media-'));
    storage = new StorageAdapter(tmpRoot);
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('renders 1080x1920 30fps yuv420p h264 MP4 from 720x1280 and square 320x320 START_FRAMEs without audio streams (LP-AT-01)', async () => {
    const portraitPng = genPng('720x1280');
    const portraitSha = createHash('sha256').update(portraitPng).digest('hex');
    await storage.write('keyframes', `${portraitSha}.png`, portraitPng);

    const outPortrait = await renderLocalPanZoomMp4({
      attemptId: '00000000-0000-4000-8000-000000000201',
      storage,
      startFrameStoragePath: `keyframes/${portraitSha}.png`,
      startFrameSha256: portraitSha,
      durationSeconds: 3,
      cameraMovement: 'Slow push in',
    });

    expect(outPortrait.mimeType).toBe('video/mp4');
    expect(outPortrait.width).toBe(1080);
    expect(outPortrait.height).toBe(1920);
    expect(outPortrait.fps).toBe(30);
    expect(outPortrait.codec).toBe('h264');
    expect(outPortrait.pixFmt).toBe('yuv420p');
    expect(outPortrait.storagePath).toBe(`videos/${outPortrait.sha256Hash}.mp4`);

    const probePortrait = await probeRenderedMp4(
      storage.resolve('videos', path.basename(outPortrait.storagePath)),
      3,
    );
    expect(probePortrait.nbFrames).toBe(90);

    const squarePng = genPng('320x320');
    const squareSha = createHash('sha256').update(squarePng).digest('hex');
    await storage.write('keyframes', `${squareSha}.png`, squarePng);

    const outSquare = await renderLocalPanZoomMp4({
      attemptId: '00000000-0000-4000-8000-000000000202',
      storage,
      startFrameStoragePath: `keyframes/${squareSha}.png`,
      startFrameSha256: squareSha,
      durationSeconds: 2,
      cameraMovement: 'Pan right smoothly',
    });

    const probeSquare = await probeRenderedMp4(
      storage.resolve('videos', path.basename(outSquare.storagePath)),
      2,
    );
    expect(probeSquare.width).toBe(1080);
    expect(probeSquare.height).toBe(1920);
    expect(probeSquare.nbFrames).toBe(60);

    const tempFiles = await fs.readdir(storage.resolveDir('temp'));
    expect(tempFiles).toEqual([]);
  });

  it('rejects corrupt non-image bytes with LOCAL_RENDER_FAILED and cleans up temp files (LP-AT-08)', async () => {
    const junk = Buffer.from('not-a-valid-png-payload');
    const junkSha = createHash('sha256').update(junk).digest('hex');
    await storage.write('keyframes', `${junkSha}.png`, junk);

    await expect(
      renderLocalPanZoomMp4({
        attemptId: '00000000-0000-4000-8000-000000000203',
        storage,
        startFrameStoragePath: `keyframes/${junkSha}.png`,
        startFrameSha256: junkSha,
        durationSeconds: 2,
        cameraMovement: 'Static',
      }),
    ).rejects.toMatchObject({ code: 'LOCAL_RENDER_FAILED' });

    const tempFiles = await fs.readdir(storage.resolveDir('temp'));
    expect(tempFiles).toEqual([]);
  });
});
