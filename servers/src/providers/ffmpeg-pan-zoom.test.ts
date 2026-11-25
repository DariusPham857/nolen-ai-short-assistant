import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StorageAdapter } from '../lib/storage.js';
import { createProviderAdapter } from './index.js';
import {
  LocalPanZoomError,
  buildPanZoomFilter,
  probeRenderedMp4,
  renderLocalPanZoomMp4,
} from './ffmpeg-pan-zoom.js';

describe('ffmpeg-pan-zoom unit behavior', () => {
  let tmpRoot: string;
  let storage: StorageAdapter;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nolen-lp02-unit-'));
    storage = new StorageAdapter(tmpRoot);
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('builds crop-safe 1080x1920 30fps zoompan filters for camera movements', () => {
    const pushFilter = buildPanZoomFilter('Slow push in', 5, 30);
    expect(pushFilter).toContain('scale=2160:3840:force_original_aspect_ratio=increase:flags=bicubic');
    expect(pushFilter).toContain('crop=2160:3840,setsar=1,zoompan=');
    expect(pushFilter).toContain(':d=150:s=1080x1920:fps=30,format=yuv420p');
    expect(pushFilter).toContain("min(1.15,1.0+0.15*(on/149))");

    const panLeftFilter = buildPanZoomFilter('Pan left smoothly', 3, 30);
    expect(panLeftFilter).toContain(':d=90:s=1080x1920:fps=30');
    expect(panLeftFilter).toContain("z='1.15'");
    expect(panLeftFilter).toContain('(1-on/89)');

    const staticFilter = buildPanZoomFilter('Static locked tripod', 2, 30);
    expect(staticFilter).toContain(':d=60:s=1080x1920:fps=30');
    expect(staticFilter).toContain("z='1.0'");
  });

  it('fails closed before spawning FFmpeg when START_FRAME is missing or SHA-256 mismatches (LP-AT-03)', async () => {
    const attemptId = '00000000-0000-4000-8000-000000000101';

    await expect(
      renderLocalPanZoomMp4(
        {
          attemptId,
          storage,
          startFrameStoragePath: 'keyframes/missing.png',
          startFrameSha256: 'a'.repeat(64),
          durationSeconds: 3,
          cameraMovement: 'Slow push in',
        },
        { ffmpegBin: 'should-not-be-called', ffprobeBin: 'should-not-be-called' },
      ),
    ).rejects.toMatchObject({
      name: 'LocalPanZoomError',
      code: 'START_FRAME_MISSING',
    });

    await storage.write('keyframes', 'start.png', Buffer.from('corrupt-bytes'));
    await expect(
      renderLocalPanZoomMp4(
        {
          attemptId,
          storage,
          startFrameStoragePath: 'keyframes/start.png',
          startFrameSha256: 'b'.repeat(64),
          durationSeconds: 3,
          cameraMovement: 'Slow push in',
        },
        { ffmpegBin: 'should-not-be-called', ffprobeBin: 'should-not-be-called' },
      ),
    ).rejects.toMatchObject({
      name: 'LocalPanZoomError',
      code: 'START_FRAME_HASH_MISMATCH',
    });
  });

  it('kills timed-out FFmpeg process with SIGKILL and cleans up all temp files (LP-AT-08)', async () => {
    const startBuf = Buffer.from('fake-png-content-for-timeout');
    const written = await storage.write('keyframes', 'timeout-start.png', startBuf);

    await expect(
      renderLocalPanZoomMp4(
        {
          attemptId: '00000000-0000-4000-8000-000000000102',
          storage,
          startFrameStoragePath: 'keyframes/timeout-start.png',
          startFrameSha256: written.sha256,
          durationSeconds: 2,
          cameraMovement: 'Slow push in',
        },
        {
          ffmpegBin: process.execPath,
          ffmpegArgsOverride: ['-e', 'setTimeout(() => {}, 5000)'],
          timeoutMs: 80,
        },
      ),
    ).rejects.toMatchObject({
      name: 'LocalPanZoomError',
      code: 'LOCAL_RENDER_TIMEOUT',
    });

    const tempFiles = await fs.readdir(storage.resolveDir('temp'));
    expect(tempFiles).toEqual([]);
    const videoFiles = await fs.readdir(storage.resolveDir('videos'));
    expect(videoFiles).toEqual([]);
  });

  it('cleans up temp files when FFmpeg exits non-zero (LP-AT-08)', async () => {
    const startBuf = Buffer.from('fake-png-content-for-fail');
    const written = await storage.write('keyframes', 'fail-start.png', startBuf);

    await expect(
      renderLocalPanZoomMp4(
        {
          attemptId: '00000000-0000-4000-8000-000000000103',
          storage,
          startFrameStoragePath: 'keyframes/fail-start.png',
          startFrameSha256: written.sha256,
          durationSeconds: 2,
          cameraMovement: 'Static',
        },
        {
          ffmpegBin: process.execPath,
          ffmpegArgsOverride: ['-e', 'process.stderr.write("encoder error"); process.exit(1);'],
        },
      ),
    ).rejects.toMatchObject({
      name: 'LocalPanZoomError',
      code: 'LOCAL_RENDER_FAILED',
    });

    const tempFiles = await fs.readdir(storage.resolveDir('temp'));
    expect(tempFiles).toEqual([]);
  });

  it('rejects invalid or wrong-duration ffprobe MP4 payloads (LP-AT-08)', async () => {
    const dummyMp4 = path.join(tmpRoot, 'dummy.mp4');
    await fs.writeFile(dummyMp4, Buffer.from('not-used-by-mock-ffprobe'));

    const wrongDurationJson = JSON.stringify({
      format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '1.200000', size: '1234' },
      streams: [
        { codec_type: 'video', codec_name: 'h264', width: 1080, height: 1920, nb_frames: '36', pix_fmt: 'yuv420p' },
      ],
    });

    await expect(
      probeRenderedMp4(dummyMp4, 3, {
        ffprobeBin: process.execPath,
        ffprobeArgsOverride: ['-e', `process.stdout.write(${JSON.stringify(wrongDurationJson)})`],
      }),
    ).rejects.toBeInstanceOf(LocalPanZoomError);

    const hasAudioJson = JSON.stringify({
      format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '3.000000', size: '1234' },
      streams: [
        { codec_type: 'video', codec_name: 'h264', width: 1080, height: 1920, nb_frames: '90', pix_fmt: 'yuv420p' },
        { codec_type: 'audio', codec_name: 'aac' },
      ],
    });

    await expect(
      probeRenderedMp4(dummyMp4, 3, {
        ffprobeBin: process.execPath,
        ffprobeArgsOverride: ['-e', `process.stdout.write(${JSON.stringify(hasAudioJson)})`],
      }),
    ).rejects.toMatchObject({ code: 'LOCAL_OUTPUT_INVALID' });
  });

  it('creates LIVE LocalPanZoomAdapter via createProviderAdapter while remote LIVE providers still throw', () => {
    const adapter = createProviderAdapter('LOCAL_PAN_ZOOM', 'LIVE');
    expect(adapter.kind).toBe('LOCAL_PAN_ZOOM');
    expect(adapter.executionMode).toBe('LIVE');
    expect(adapter.isFake).toBe(false);
    expect(() => createProviderAdapter('GEMINI', 'LIVE')).toThrow('LIVE_PROVIDER_UNAVAILABLE');
  });
});
