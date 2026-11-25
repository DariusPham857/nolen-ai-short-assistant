import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { StorageAdapter } from '../lib/storage.js';

type StorageCategory = Parameters<StorageAdapter['write']>[0];

export type LocalPanZoomErrorCode =
  | 'START_FRAME_MISSING'
  | 'START_FRAME_HASH_MISMATCH'
  | 'LOCAL_RENDER_TIMEOUT'
  | 'LOCAL_RENDER_FAILED'
  | 'LOCAL_OUTPUT_INVALID';

export class LocalPanZoomError extends Error {
  public readonly code: LocalPanZoomErrorCode;
  public readonly status: number;
  public readonly details?: Record<string, unknown>;

  constructor(
    code: LocalPanZoomErrorCode,
    status: number,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'LocalPanZoomError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export interface RenderLocalPanZoomInput {
  attemptId: string;
  storage: StorageAdapter;
  startFrameStoragePath: string;
  startFrameSha256: string;
  durationSeconds: number;
  cameraMovement: string;
}

export interface RenderLocalPanZoomOptions {
  ffmpegBin?: string;
  ffprobeBin?: string;
  ffmpegArgsOverride?: string[];
  ffprobeArgsOverride?: string[];
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface RenderedLocalMp4Result {
  storagePath: string;
  sha256Hash: string;
  byteSize: number;
  durationSeconds: number;
  width: number;
  height: number;
  fps: number;
  codec: 'h264';
  pixFmt: 'yuv420p';
  mimeType: 'video/mp4';
}

export interface ProbedMp4Metadata {
  durationSeconds: number;
  width: number;
  height: number;
  nbFrames: number | null;
  codec: string;
  pixFmt: string;
  byteSize: number;
}

const DEFAULT_FPS = 30;
const TARGET_WIDTH = 1080;
const TARGET_HEIGHT = 1920;
const SCALE_WIDTH = 2160;
const SCALE_HEIGHT = 3840;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;
const FFMPEG_MAX_ALLOC_BYTES = '268435456';

interface SubprocessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: Buffer;
  stderr: Buffer;
  timedOut: boolean;
  outputOverflow: boolean;
}

function runFileSubprocess(
  bin: string,
  args: string[],
  timeoutMs: number,
  maxOutputBytes: number,
): Promise<SubprocessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let outputOverflow = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    const finish = (err?: Error, code?: number | null, signal?: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) {
        reject(err);
        return;
      }
      resolve({
        code: code ?? null,
        signal: signal ?? null,
        stdout: Buffer.concat(stdoutChunks),
        stderr: Buffer.concat(stderrChunks),
        timedOut,
        outputOverflow,
      });
    };

    child.on('error', (err: NodeJS.ErrnoException) => {
      finish(
        new LocalPanZoomError(
          'LOCAL_RENDER_FAILED',
          err.code === 'ENOENT' ? 503 : 422,
          `Failed to execute media tool "${bin}": ${err.message}`,
        ),
      );
    });

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > maxOutputBytes) {
        outputOverflow = true;
        child.kill('SIGKILL');
        return;
      }
      stdoutChunks.push(chunk);
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > maxOutputBytes) {
        outputOverflow = true;
        child.kill('SIGKILL');
        return;
      }
      stderrChunks.push(chunk);
    });

    child.on('close', (code, signal) => {
      finish(undefined, code, signal);
    });
  });
}

function parseStartFramePath(storagePath: string): { category: StorageCategory; filename: string } {
  const parts = storagePath.split('/');
  if (parts.length !== 2) {
    throw new LocalPanZoomError('START_FRAME_MISSING', 422, `Invalid START_FRAME storage path: ${storagePath}`);
  }
  const [category, filename] = parts;
  if (category !== 'keyframes' && category !== 'references') {
    throw new LocalPanZoomError('START_FRAME_MISSING', 422, `Unsupported START_FRAME category: ${category}`);
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(filename)) {
    throw new LocalPanZoomError('START_FRAME_MISSING', 422, `Unsafe START_FRAME filename: ${filename}`);
  }
  return { category, filename };
}

/**
 * Compiles a deterministic crop-safe 9:16 zoompan filtergraph verified on FFmpeg 5.1.9.
 */
export function buildPanZoomFilter(movement: string, durationSeconds: number, fps = DEFAULT_FPS): string {
  if (!Number.isInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > 60) {
    throw new LocalPanZoomError(
      'LOCAL_RENDER_FAILED',
      422,
      `Duration must be an integer between 1 and 60 seconds, received ${durationSeconds}`,
    );
  }
  const totalFrames = Math.max(1, Math.round(durationSeconds * fps));
  const denom = Math.max(1, totalFrames - 1);
  const m = movement.trim().toLowerCase();

  let zoomExpr: string;
  if (m === 'static' || m.includes('locked') || m.includes('tripod') || m === 'none' || m === 'hold') {
    zoomExpr = `z='1.0':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'`;
  } else if (m.includes('left')) {
    zoomExpr = `z='1.15':x='(iw-iw/zoom)*(1-on/${denom})':y='(ih-ih/zoom)/2'`;
  } else if (m.includes('right')) {
    zoomExpr = `z='1.15':x='(iw-iw/zoom)*(on/${denom})':y='(ih-ih/zoom)/2'`;
  } else if (m.includes('up')) {
    zoomExpr = `z='1.15':x='(iw-iw/zoom)/2':y='(ih-ih/zoom)*(1-on/${denom})'`;
  } else if (m.includes('down')) {
    zoomExpr = `z='1.15':x='(iw-iw/zoom)/2':y='(ih-ih/zoom)*(on/${denom})'`;
  } else if (m.includes('out') || m.includes('pull')) {
    zoomExpr = `z='max(1.0,1.15-0.15*(on/${denom}))':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'`;
  } else {
    zoomExpr = `z='min(1.15,1.0+0.15*(on/${denom}))':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'`;
  }

  return [
    `scale=${SCALE_WIDTH}:${SCALE_HEIGHT}:force_original_aspect_ratio=increase:flags=bicubic`,
    `crop=${SCALE_WIDTH}:${SCALE_HEIGHT}`,
    'setsar=1',
    `zoompan=${zoomExpr}:d=${totalFrames}:s=${TARGET_WIDTH}x${TARGET_HEIGHT}:fps=${fps}`,
    'format=yuv420p',
  ].join(',');
}

interface FfprobeJson {
  format?: {
    format_name?: string;
    duration?: string;
    size?: string;
  };
  streams?: Array<{
    codec_type?: string;
    codec_name?: string;
    width?: number;
    height?: number;
    nb_frames?: string;
    pix_fmt?: string;
  }>;
}

/**
 * Validates rendered MP4 conforms to DEC-P03 output specs (1080x1920 h264 yuv420p, exact duration, 0 audio streams).
 */
export async function probeRenderedMp4(
  mp4Path: string,
  expectedDurationSeconds: number,
  options?: RenderLocalPanZoomOptions,
): Promise<ProbedMp4Metadata> {
  const ffprobeBin = options?.ffprobeBin ?? 'ffprobe';
  const args = options?.ffprobeArgsOverride ?? [
    '-v',
    'error',
    '-show_entries',
    'format=format_name,duration,size:stream=codec_type,codec_name,width,height,nb_frames,pix_fmt',
    '-of',
    'json',
    mp4Path,
  ];
  const res = await runFileSubprocess(
    ffprobeBin,
    args,
    options?.timeoutMs ?? 15_000,
    options?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
  );

  if (res.timedOut || res.outputOverflow || res.code !== 0) {
    throw new LocalPanZoomError('LOCAL_OUTPUT_INVALID', 422, 'ffprobe failed to inspect rendered MP4', {
      exitCode: res.code,
      timedOut: res.timedOut,
      stderr: res.stderr.toString('utf8').slice(0, 500),
    });
  }

  let parsed: FfprobeJson;
  try {
    parsed = JSON.parse(res.stdout.toString('utf8')) as FfprobeJson;
  } catch {
    throw new LocalPanZoomError('LOCAL_OUTPUT_INVALID', 422, 'ffprobe emitted malformed JSON metadata');
  }

  const formatNames = (parsed.format?.format_name ?? '')
    .split(',')
    .map(s => s.trim().toLowerCase());
  if (!formatNames.includes('mp4')) {
    throw new LocalPanZoomError('LOCAL_OUTPUT_INVALID', 422, `Unexpected container format: ${parsed.format?.format_name}`);
  }

  const streams = parsed.streams ?? [];
  const audioStreams = streams.filter(s => s.codec_type === 'audio');
  if (audioStreams.length > 0) {
    throw new LocalPanZoomError('LOCAL_OUTPUT_INVALID', 422, 'Local pan/zoom MP4 must contain zero audio streams');
  }
  const videoStreams = streams.filter(s => s.codec_type === 'video');
  if (videoStreams.length !== 1) {
    throw new LocalPanZoomError('LOCAL_OUTPUT_INVALID', 422, `Expected 1 video stream, got ${videoStreams.length}`);
  }

  const video = videoStreams[0];
  if (
    video.codec_name !== 'h264' ||
    video.width !== TARGET_WIDTH ||
    video.height !== TARGET_HEIGHT ||
    video.pix_fmt !== 'yuv420p'
  ) {
    throw new LocalPanZoomError('LOCAL_OUTPUT_INVALID', 422, 'Rendered MP4 video stream failed spec validation', {
      codec: video.codec_name,
      width: video.width,
      height: video.height,
      pixFmt: video.pix_fmt,
    });
  }

  const durationSeconds = Number(parsed.format?.duration);
  if (!Number.isFinite(durationSeconds) || Math.abs(durationSeconds - expectedDurationSeconds) > 0.1) {
    throw new LocalPanZoomError(
      'LOCAL_OUTPUT_INVALID',
      422,
      `Rendered duration ${parsed.format?.duration} does not match expected ${expectedDurationSeconds}s`,
    );
  }

  let nbFrames: number | null = null;
  if (video.nb_frames !== undefined) {
    const parsedFrames = Number(video.nb_frames);
    if (!Number.isInteger(parsedFrames) || Math.abs(parsedFrames - expectedDurationSeconds * DEFAULT_FPS) > 2) {
      throw new LocalPanZoomError(
        'LOCAL_OUTPUT_INVALID',
        422,
        `Rendered frame count ${video.nb_frames} does not match ${expectedDurationSeconds * DEFAULT_FPS}`,
      );
    }
    nbFrames = parsedFrames;
  }

  const byteSize = Number(parsed.format?.size);
  if (!Number.isFinite(byteSize) || byteSize <= 0) {
    throw new LocalPanZoomError('LOCAL_OUTPUT_INVALID', 422, 'Rendered MP4 has non-positive byte size');
  }

  return {
    durationSeconds,
    width: TARGET_WIDTH,
    height: TARGET_HEIGHT,
    nbFrames,
    codec: 'h264',
    pixFmt: 'yuv420p',
    byteSize,
  };
}

/**
 * Reads an approved START_FRAME via StorageAdapter, verifies SHA-256, renders a deterministic 9:16 MP4
 * via bounded FFmpeg subprocess, probes output, and writes content-addressed videos/<sha256>.mp4.
 */
export async function renderLocalPanZoomMp4(
  input: RenderLocalPanZoomInput,
  options?: RenderLocalPanZoomOptions,
): Promise<RenderedLocalMp4Result> {
  const { category, filename } = parseStartFramePath(input.startFrameStoragePath);

  let startBuffer: Buffer;
  try {
    startBuffer = await input.storage.read(category, filename);
  } catch (err) {
    throw new LocalPanZoomError(
      'START_FRAME_MISSING',
      422,
      `START_FRAME file missing on disk at ${input.startFrameStoragePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const actualStartSha = createHash('sha256').update(startBuffer).digest('hex');
  if (actualStartSha !== input.startFrameSha256) {
    throw new LocalPanZoomError(
      'START_FRAME_HASH_MISMATCH',
      422,
      `START_FRAME SHA-256 mismatch: expected ${input.startFrameSha256}, found ${actualStartSha}`,
    );
  }

  const filter = buildPanZoomFilter(input.cameraMovement, input.durationSeconds, DEFAULT_FPS);
  const runId = randomUUID();
  const safeAttemptId = path.basename(input.attemptId).replace(/[^a-zA-Z0-9_-]/g, '');
  const tempDir = input.storage.resolveDir('temp');
  await fs.mkdir(tempDir, { recursive: true });
  const tempInPath = input.storage.resolve('temp', `${safeAttemptId}-${runId}.img`);
  const tempOutPath = input.storage.resolve('temp', `${safeAttemptId}-${runId}.mp4`);

  try {
    await fs.writeFile(tempInPath, startBuffer);

    const ffmpegBin = options?.ffmpegBin ?? 'ffmpeg';
    const args = options?.ffmpegArgsOverride ?? [
      '-v',
      'error',
      '-y',
      '-protocol_whitelist',
      'file,pipe',
      '-threads',
      '2',
      '-max_alloc',
      FFMPEG_MAX_ALLOC_BYTES,
      '-i',
      tempInPath,
      '-vf',
      filter,
      '-t',
      String(input.durationSeconds),
      '-c:v',
      'libx264',
      '-preset',
      'fast',
      '-crf',
      '20',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      '-an',
      tempOutPath,
    ];

    const res = await runFileSubprocess(
      ffmpegBin,
      args,
      options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      options?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    );

    if (res.timedOut) {
      throw new LocalPanZoomError('LOCAL_RENDER_TIMEOUT', 504, `FFmpeg pan/zoom timed out for attempt ${input.attemptId}`);
    }
    if (res.outputOverflow || res.code !== 0) {
      throw new LocalPanZoomError('LOCAL_RENDER_FAILED', 422, `FFmpeg pan/zoom exited with code ${res.code}`, {
        stderr: res.stderr.toString('utf8').slice(0, 500),
      });
    }

    await probeRenderedMp4(tempOutPath, input.durationSeconds, options);

    const mp4Buffer = await fs.readFile(tempOutPath);
    const filename = `${createHash('sha256').update(mp4Buffer).digest('hex')}.mp4`;
    const stored = await input.storage.write('videos', filename, mp4Buffer);

    return {
      storagePath: `videos/${filename}`,
      sha256Hash: stored.sha256,
      byteSize: mp4Buffer.byteLength,
      durationSeconds: input.durationSeconds,
      width: TARGET_WIDTH,
      height: TARGET_HEIGHT,
      fps: DEFAULT_FPS,
      codec: 'h264',
      pixFmt: 'yuv420p',
      mimeType: 'video/mp4',
    };
  } finally {
    await fs.rm(tempInPath, { force: true }).catch(() => undefined);
    await fs.rm(tempOutPath, { force: true }).catch(() => undefined);
  }
}
