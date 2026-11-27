import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { providerStatusUpdateSchema, submissionResultSchema } from '@nolen/contracts';
import { StorageAdapter } from '../lib/storage.js';
import { createProviderAdapter } from './index.js';
import { LocalPanZoomAdapter } from './local-pan-zoom.js';
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
    const prevGem = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      const adapter = createProviderAdapter('LOCAL_PAN_ZOOM', 'LIVE');
      expect(adapter.kind).toBe('LOCAL_PAN_ZOOM');
      expect(adapter.executionMode).toBe('LIVE');
      expect(adapter.isFake).toBe(false);
      expect(() => createProviderAdapter('GEMINI', 'LIVE')).toThrow('LIVE_PROVIDER_UNAVAILABLE');
    } finally {
      if (prevGem !== undefined) process.env.GEMINI_API_KEY = prevGem;
    }
  });

  it('publishes videos atomically without overwriting existing blobs and preserves prior blob on crash/conflict', async () => {
    const startBuf = Buffer.from('deterministic-start-frame');
    const writtenStart = await storage.write('keyframes', 'dup-start.png', startBuf);

    const renderedPayload = Buffer.from('deterministic-mp4-output-bytes');
    const expectedVideoSha = createHash('sha256').update(renderedPayload).digest('hex');
    const targetPath = storage.resolve('videos', `${expectedVideoSha}.mp4`);
    storage.resolveDir('videos');
    await fs.writeFile(targetPath, renderedPayload);
    const statBefore = await fs.stat(targetPath);

    const validProbeJson = JSON.stringify({
      format: { format_name: 'mov,mp4', duration: '2.000000', size: String(renderedPayload.byteLength) },
      streams: [{ codec_type: 'video', codec_name: 'h264', width: 1080, height: 1920, nb_frames: '60', pix_fmt: 'yuv420p' }],
    });
    const fakeFfmpegArgs = (_in: string, out: string) => [
      '-e',
      `require('node:fs').writeFileSync(${JSON.stringify(out)}, Buffer.from(${JSON.stringify(renderedPayload.toString('base64'))}, 'base64'));`,
    ];

    // 1. Re-publishing identical content succeeds without truncating or replacing existing inode
    const second = await renderLocalPanZoomMp4(
      {
        attemptId: '00000000-0000-4000-8000-000000000104',
        storage,
        startFrameStoragePath: 'keyframes/dup-start.png',
        startFrameSha256: writtenStart.sha256,
        durationSeconds: 2,
        cameraMovement: 'Static',
      },
      {
        ffmpegBin: process.execPath,
        ffmpegArgsOverride: fakeFfmpegArgs,
        ffprobeBin: process.execPath,
        ffprobeArgsOverride: ['-e', `process.stdout.write(${JSON.stringify(validProbeJson)})`],
      },
    );
    expect(second.sha256Hash).toBe(expectedVideoSha);
    const statAfter = await fs.stat(targetPath);
    expect(statAfter.ino).toBe(statBefore.ino);
    expect(await fs.readFile(targetPath)).toEqual(renderedPayload);

    // 2. Crash before publish leaves existing blob intact and cleans temp
    await expect(
      renderLocalPanZoomMp4(
        {
          attemptId: '00000000-0000-4000-8000-000000000105',
          storage,
          startFrameStoragePath: 'keyframes/dup-start.png',
          startFrameSha256: writtenStart.sha256,
          durationSeconds: 2,
          cameraMovement: 'Static',
        },
        {
          ffmpegBin: process.execPath,
          ffmpegArgsOverride: fakeFfmpegArgs,
          ffprobeBin: process.execPath,
          ffprobeArgsOverride: ['-e', `process.stdout.write(${JSON.stringify(validProbeJson)})`],
          simulateCrashAt: 'BEFORE_PUBLISH',
        },
      ),
    ).rejects.toThrow('SIMULATED_CRASH_BEFORE_PUBLISH');
    expect(await fs.readFile(targetPath)).toEqual(renderedPayload);
    expect(await fs.readdir(storage.resolveDir('temp'))).toEqual([]);

    // 3. Corrupted existing blob fails closed without overwriting
    await fs.writeFile(targetPath, Buffer.from('corrupted-existing-blob'));
    await expect(
      renderLocalPanZoomMp4(
        {
          attemptId: '00000000-0000-4000-8000-000000000106',
          storage,
          startFrameStoragePath: 'keyframes/dup-start.png',
          startFrameSha256: writtenStart.sha256,
          durationSeconds: 2,
          cameraMovement: 'Static',
        },
        {
          ffmpegBin: process.execPath,
          ffmpegArgsOverride: fakeFfmpegArgs,
          ffprobeBin: process.execPath,
          ffprobeArgsOverride: ['-e', `process.stdout.write(${JSON.stringify(validProbeJson)})`],
        },
      ),
    ).rejects.toMatchObject({ code: 'LOCAL_OUTPUT_INVALID', status: 409 });
    expect(await fs.readFile(targetPath)).toEqual(Buffer.from('corrupted-existing-blob'));
  });

  it('rejects pollStatus("never-rendered") and unbacked submit() in LIVE LocalPanZoomAdapter, and validates real LIVE outputs against schemas', async () => {
    const unbackedLive = new LocalPanZoomAdapter('LIVE');
    await expect(unbackedLive.pollStatus('never-rendered')).rejects.toThrow('LOCAL_PAN_ZOOM_JOB_NOT_FOUND');

    const startBuf = Buffer.from('live-adapter-start-frame');
    const writtenStart = await storage.write('keyframes', 'adapter-start.png', startBuf);
    const renderedPayload = Buffer.from('live-adapter-mp4-bytes');
    const validProbeJson = JSON.stringify({
      format: { format_name: 'mov,mp4', duration: '2.000000', size: String(renderedPayload.byteLength) },
      streams: [{ codec_type: 'video', codec_name: 'h264', width: 1080, height: 1920, nb_frames: '60', pix_fmt: 'yuv420p' }],
    });
    const fakeFfmpegArgs = (_in: string, out: string) => [
      '-e',
      `require('node:fs').writeFileSync(${JSON.stringify(out)}, Buffer.from(${JSON.stringify(renderedPayload.toString('base64'))}, 'base64'));`,
    ];

    const request = {
      schemaVersion: '2' as const,
      attemptId: '00000000-0000-4000-8000-000000000301',
      filmId: '00000000-0000-4000-8000-000000000302',
      storyRevisionId: '00000000-0000-4000-8000-000000000303',
      shotRevisionId: '00000000-0000-4000-8000-000000000304',
      kind: 'VIDEO' as const,
      provider: 'LOCAL_PAN_ZOOM' as const,
      modelId: 'ffmpeg-pan-zoom',
      rateCardSnapshotId: '00000000-0000-4000-a000-000000000005',
      executionMode: 'LIVE' as const,
      prompt: 'Camera: movement=Static',
      negativePrompt: '',
      promptCompilerVersion: 'generation-intent-1' as const,
      shotDependencyHash: 'a'.repeat(64),
      camera: { angle: 'EYE_LEVEL' as const, framing: 'Medium', movement: 'Static' },
      aspectRatio: '9:16' as const,
      durationSeconds: 2,
      inputAssets: [
        {
          source: 'GENERATED_ASSET' as const,
          role: 'START_FRAME' as const,
          assetId: '00000000-0000-4000-8000-000000000305',
          sha256Hash: writtenStart.sha256,
          mimeType: 'image/png',
        },
      ],
      structuredIntent: {
        shotType: 'ESTABLISHING' as const,
        authoredPrompt: 'Test static shot',
        camera: { angle: 'EYE_LEVEL' as const, framing: 'Medium', movement: 'Static' },
        location: { id: 'loc1', name: 'Room', description: 'Quiet room' },
        styleRef: { id: 'style1', name: 'Cinema', description: 'Natural light' },
        subjects: [],
        wardrobes: [],
        props: [],
        continuity: { startLighting: 'Soft', endLighting: 'Soft', startCharacters: [], endCharacters: [] },
        intendedTransitions: [],
      },
    };

    await expect(unbackedLive.submit(request)).rejects.toThrow('LIVE_LOCAL_PAN_ZOOM_DIRECT_SUBMIT_UNSUPPORTED');

    const backedLive = new LocalPanZoomAdapter('LIVE', {
      storage,
      resolveStartFrame: async () => ({
        storagePath: 'keyframes/adapter-start.png',
        sha256Hash: writtenStart.sha256,
      }),
      renderOptions: {
        ffmpegBin: process.execPath,
        ffmpegArgsOverride: fakeFfmpegArgs,
        ffprobeBin: process.execPath,
        ffprobeArgsOverride: ['-e', `process.stdout.write(${JSON.stringify(validProbeJson)})`],
      },
    });

    const submission = await backedLive.submit(request);
    expect(() => submissionResultSchema.parse(submission)).not.toThrow();
    expect(submission.provenance).toBe('LOCAL_PIPELINE');

    const status = await backedLive.pollStatus(submission.providerJobId);
    expect(() => providerStatusUpdateSchema.parse(status)).not.toThrow();
    expect(status.provenance).toBe('LOCAL_PIPELINE');
    expect(status.locator?.kind).toBe('LOCAL_STORAGE');
  });
});
