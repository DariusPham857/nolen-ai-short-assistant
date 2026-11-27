import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { StorageAdapter, storage as defaultStorage } from './storage.js';
import { resolveAndValidateRemoteUrl, type DnsLookupFn, type ValidatedRemoteTarget } from './ssrf.js';

export const DEFAULT_IMAGE_MAX_BYTES = 20 * 1024 * 1024; // 20 MiB
export const DEFAULT_VIDEO_MAX_BYTES = 100 * 1024 * 1024; // 100 MiB
export const DEFAULT_DOWNLOAD_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_REDIRECTS = 3;

export type PinnedTransportFn = (
  target: ValidatedRemoteTarget,
  options: { timeoutMs: number; signal?: AbortSignal; headers: Record<string, string> },
) => Promise<IncomingMessage | {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  stream: AsyncIterable<Buffer | Uint8Array>;
  destroy: () => void;
}>;

export interface DownloadRemoteAssetOptions {
  url: string;
  category: 'keyframes' | 'videos';
  extension?: string;
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  storage?: StorageAdapter;
  lookupFn?: DnsLookupFn;
  transportFn?: PinnedTransportFn;
  signal?: AbortSignal;
}

export interface DownloadedRemoteAsset {
  storagePath: string;
  filename: string;
  sha256: string;
  byteSize: number;
  contentType: string;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const defaultPinnedTransport: PinnedTransportFn = (target, options) => {
  return new Promise((resolve, reject) => {
    const isHttps = target.url.protocol === 'https:';
    const requestMod = isHttps ? https : http;
    const req = requestMod.request(
      target.url,
      {
        method: 'GET',
        headers: options.headers,
        timeout: options.timeoutMs,
        signal: options.signal,
        // Pin socket directly to the pre-validated public unicast IP (prevents DNS rebinding)
        lookup: (_hostname, _opts, cb) => {
          cb(null, target.resolvedIp, target.family);
        },
        ...(isHttps ? { servername: target.url.hostname } : {}),
      },
      res => {
        resolve(res);
      },
    );

    req.on('timeout', () => {
      req.destroy(new Error('REMOTE_DOWNLOAD_TIMEOUT'));
    });
    req.on('error', err => {
      reject(err);
    });
    req.end();
  });
};

function isIncomingMessage(res: unknown): res is IncomingMessage {
  return typeof res === 'object' && res !== null && 'pipe' in res && typeof (res as IncomingMessage).destroy === 'function' && !('stream' in res);
}

/**
 * Downloads a remote media asset under strict SSRF containment:
 * - Resolves DNS and asserts all IPs pass isPublicUnicastIp()
 * - Pins the TCP/TLS socket to the validated public IP (prevents DNS rebinding)
 * - Disables automatic redirects and validates every redirect target (max 3 hops)
 * - Strips all Authorization/credential headers (anonymous GET only)
 * - Enforces hard byte size ceiling and overall request timeout
 * - Computes SHA-256 while streaming to temp file and moves atomically into content-addressed storage
 */
export async function downloadRemoteAsset(options: DownloadRemoteAssetOptions): Promise<DownloadedRemoteAsset> {
  const storageAdapter = options.storage ?? defaultStorage;
  const maxBytes =
    options.maxBytes ??
    (options.category === 'keyframes' ? DEFAULT_IMAGE_MAX_BYTES : DEFAULT_VIDEO_MAX_BYTES);
  const timeoutMs = options.timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const ext = options.extension ?? (options.category === 'keyframes' ? '.png' : '.mp4');
  const transport = options.transportFn ?? defaultPinnedTransport;

  const deadlineSignal = AbortSignal.timeout(timeoutMs);
  const combinedSignal = options.signal
    ? AbortSignal.any([options.signal, deadlineSignal])
    : deadlineSignal;

  let currentUrl = options.url;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const validated = await resolveAndValidateRemoteUrl(currentUrl, options.lookupFn);

    // Strip any credentials or auth headers; only send Host and generic Accept
    const headers: Record<string, string> = {
      Host: validated.url.host,
      Accept: '*/*',
    };

    const res = await transport(validated, {
      timeoutMs,
      signal: combinedSignal,
      headers,
    });

    const statusCode = res.statusCode ?? 0;
    const resHeaders = res.headers;

    if (REDIRECT_STATUSES.has(statusCode)) {
      res.destroy();
      if (hop >= maxRedirects) {
        throw new Error('SSRF_TOO_MANY_REDIRECTS');
      }
      const rawLocation = resHeaders.location;
      const location = Array.isArray(rawLocation) ? rawLocation[0] : rawLocation;
      if (!location) {
        throw new Error('REMOTE_DOWNLOAD_INVALID_REDIRECT');
      }
      currentUrl = new URL(location, validated.url).toString();
      continue;
    }

    if (statusCode < 200 || statusCode >= 300) {
      res.destroy();
      throw new Error(`REMOTE_DOWNLOAD_HTTP_ERROR: status ${statusCode}`);
    }

    const rawContentLength = resHeaders['content-length'];
    const contentLengthHeader = Array.isArray(rawContentLength) ? rawContentLength[0] : rawContentLength;
    if (contentLengthHeader !== undefined) {
      const declared = Number(contentLengthHeader);
      if (Number.isFinite(declared) && declared > maxBytes) {
        res.destroy();
        throw new Error('PAYLOAD_TOO_LARGE');
      }
    }

    const rawContentType = resHeaders['content-type'];
    const contentType =
      (Array.isArray(rawContentType) ? rawContentType[0] : rawContentType) ??
      (options.category === 'keyframes' ? 'image/png' : 'video/mp4');

    const tempPath = storageAdapter.resolve('temp', `.remote-dl-${randomUUID()}`);
    const hash = createHash('sha256');
    let totalBytes = 0;
    const writeStream = createWriteStream(tempPath, { flags: 'wx', mode: 0o600 });

    try {
      const iterable: AsyncIterable<Buffer | Uint8Array> = isIncomingMessage(res) ? res : res.stream;
      for await (const rawChunk of iterable) {
        if (combinedSignal.aborted) {
          throw combinedSignal.reason instanceof Error ? combinedSignal.reason : new Error('REMOTE_DOWNLOAD_ABORTED');
        }
        const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
        totalBytes += chunk.byteLength;
        if (totalBytes > maxBytes) {
          res.destroy();
          throw new Error('PAYLOAD_TOO_LARGE');
        }
        hash.update(chunk);
        if (!writeStream.write(chunk)) {
          await new Promise<void>((resolveWrite, rejectWrite) => {
            writeStream.once('drain', resolveWrite);
            writeStream.once('error', rejectWrite);
          });
        }
      }

      await new Promise<void>((resolveEnd, rejectEnd) => {
        writeStream.once('error', rejectEnd);
        writeStream.end(() => resolveEnd());
      });

      const sha256 = hash.digest('hex');
      const filename = `${sha256}${ext}`;
      const finalPath = storageAdapter.resolve(options.category, filename);

      try {
        await fs.rename(tempPath, finalPath);
      } catch {
        // Content-addressed fallback if target exists or cross-device move needed
        if (storageAdapter.exists(options.category, filename)) {
          const ok = await storageAdapter.verify(options.category, filename, sha256).catch(() => false);
          if (ok) {
            await fs.unlink(tempPath).catch(() => undefined);
          } else {
            await fs.copyFile(tempPath, finalPath);
            await fs.unlink(tempPath).catch(() => undefined);
          }
        } else {
          await fs.copyFile(tempPath, finalPath);
          await fs.unlink(tempPath).catch(() => undefined);
        }
      }

      return {
        storagePath: `${options.category}/${filename}`,
        filename,
        sha256,
        byteSize: totalBytes,
        contentType,
      };
    } catch (err) {
      await new Promise<void>(resolveClose => {
        if (writeStream.closed) {
          resolveClose();
        } else {
          writeStream.once('close', () => resolveClose());
          writeStream.destroy();
        }
      });
      await fs.unlink(tempPath).catch(() => undefined);
      throw err;
    }
  }

  throw new Error('SSRF_TOO_MANY_REDIRECTS');
}
