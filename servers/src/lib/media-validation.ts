import { spawn } from 'node:child_process';
import { ApiFailure } from '../http/errors.js';

export type ReferenceImageMime = 'image/png' | 'image/jpeg' | 'image/webp';

export interface ValidatedReferenceImage {
  mimeType: ReferenceImageMime;
  width: number;
  height: number;
}

export interface MediaValidationOptions {
  ffprobeBin?: string;
  ffmpegBin?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const MIN_DIMENSION = 300;
const MAX_DIMENSION = 4096;
const MAX_PIXELS = 16_777_216;
const FFMPEG_MAX_ALLOC_BYTES = '268435456'; // 256 MiB verified in Bookworm image

interface SubprocessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: Buffer;
  stderr: Buffer;
  timedOut: boolean;
  outputOverflow: boolean;
}

export function runStdinSubprocess(
  bin: string,
  args: string[],
  input: Buffer,
  timeoutMs: number,
  maxOutputBytes: number,
): Promise<SubprocessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
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
      if (err.code === 'ENOENT') {
        finish(new ApiFailure(503, 'MEDIA_TOOL_UNAVAILABLE', `Required media tool "${bin}" is not available`));
      } else {
        finish(new ApiFailure(422, 'REFERENCE_IMAGE_UNSAFE', `Failed to execute media tool "${bin}"`));
      }
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

    child.stdin.on('error', () => {
      // Child may exit early on invalid header before stdin finishes writing
    });

    child.on('close', (code, signal) => {
      finish(undefined, code, signal);
    });

    child.stdin.end(input);
  });
}

function mapFormatToMime(formatName: string | undefined, codecName: string | undefined): ReferenceImageMime | null {
  if (formatName === 'png_pipe' && codecName === 'png') return 'image/png';
  if (formatName === 'jpeg_pipe' && codecName === 'mjpeg') return 'image/jpeg';
  if (formatName === 'webp_pipe' && codecName === 'webp') return 'image/webp';
  return null;
}

/**
 * Validates that an uploaded buffer is a safe, static PNG, JPEG, or WebP image
 * within dimension/pixel bounds using stdin-only ffprobe + ffmpeg subprocesses.
 */
export async function validateStaticReferenceImage(
  buffer: Buffer,
  options: MediaValidationOptions = {},
): Promise<ValidatedReferenceImage> {
  const ffprobeBin = options.ffprobeBin ?? 'ffprobe';
  const ffmpegBin = options.ffmpegBin ?? 'ffmpeg';
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

  const probe = await runStdinSubprocess(
    ffprobeBin,
    [
      '-v', 'error',
      '-protocol_whitelist', 'pipe',
      '-show_entries', 'format=format_name,nb_streams:stream=codec_name,width,height,nb_frames',
      '-of', 'json',
      '-i', 'pipe:0',
    ],
    buffer,
    timeoutMs,
    maxOutputBytes,
  );

  if (probe.timedOut) {
    throw new ApiFailure(422, 'REFERENCE_IMAGE_VALIDATION_TIMEOUT', 'Image inspection timed out');
  }
  if (probe.outputOverflow || probe.code !== 0) {
    throw new ApiFailure(422, 'REFERENCE_IMAGE_UNSAFE', 'Uploaded file failed media container inspection');
  }

  let parsed: {
    format?: { format_name?: string; nb_streams?: number };
    streams?: Array<{ codec_name?: string; width?: number; height?: number; nb_frames?: string }>;
  };
  try {
    parsed = JSON.parse(probe.stdout.toString('utf8')) as typeof parsed;
  } catch {
    throw new ApiFailure(422, 'REFERENCE_IMAGE_UNSAFE', 'Unreadable media probe output');
  }

  if (parsed.format?.nb_streams !== 1 || !parsed.streams || parsed.streams.length !== 1) {
    throw new ApiFailure(422, 'REFERENCE_IMAGE_UNSAFE', 'Reference image must contain exactly one visual stream');
  }

  const stream = parsed.streams[0];
  const mimeType = mapFormatToMime(parsed.format?.format_name, stream.codec_name);
  if (!mimeType) {
    throw new ApiFailure(422, 'REFERENCE_IMAGE_UNSAFE', 'Only static PNG, JPEG, and WebP images are permitted');
  }

  if (stream.nb_frames !== undefined) {
    const nbFrames = Number(stream.nb_frames);
    if (!Number.isFinite(nbFrames) || nbFrames !== 1) {
      throw new ApiFailure(422, 'REFERENCE_IMAGE_UNSAFE', 'Animated images are not permitted');
    }
  }

  const width = stream.width;
  const height = stream.height;
  if (
    typeof width !== 'number' ||
    typeof height !== 'number' ||
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < MIN_DIMENSION ||
    height < MIN_DIMENSION ||
    width > MAX_DIMENSION ||
    height > MAX_DIMENSION ||
    width * height > MAX_PIXELS
  ) {
    throw new ApiFailure(
      422,
      'REFERENCE_IMAGE_UNSAFE',
      `Image dimensions must be ${MIN_DIMENSION}–${MAX_DIMENSION}px per side and at most ${MAX_PIXELS} total pixels`,
    );
  }

  // Decode up to 2 frames via stdin to reject animated streams and truncated/corrupt payloads
  const decode = await runStdinSubprocess(
    ffmpegBin,
    [
      '-v', 'error',
      '-xerror',
      '-err_detect', 'explode',
      '-protocol_whitelist', 'pipe',
      '-threads', '1',
      '-max_alloc', FFMPEG_MAX_ALLOC_BYTES,
      '-i', 'pipe:0',
      '-frames:v', '2',
      '-f', 'framecrc',
      'pipe:1',
    ],
    buffer,
    timeoutMs,
    maxOutputBytes,
  );

  if (decode.timedOut) {
    throw new ApiFailure(422, 'REFERENCE_IMAGE_VALIDATION_TIMEOUT', 'Image decode timed out');
  }
  if (decode.outputOverflow || decode.code !== 0) {
    throw new ApiFailure(422, 'REFERENCE_IMAGE_UNSAFE', 'Uploaded image failed strict pixel decode');
  }

  const decodedFrames = decode.stdout
    .toString('utf8')
    .split('\n')
    .filter(line => line.trim().length > 0 && !line.startsWith('#')).length;

  if (decodedFrames !== 1) {
    throw new ApiFailure(422, 'REFERENCE_IMAGE_UNSAFE', 'Reference image must decode as exactly one static frame');
  }

  return { mimeType, width, height };
}
