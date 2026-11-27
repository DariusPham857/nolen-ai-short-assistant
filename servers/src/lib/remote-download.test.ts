import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StorageAdapter } from './storage.js';
import { downloadRemoteAsset, type PinnedTransportFn } from './remote-download.js';

describe('Pinned SSRF-Contained Remote Downloader (PD-05b.2)', () => {
  let tempRoot: string;
  let testStorage: StorageAdapter;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nolen-remote-dl-'));
    testStorage = new StorageAdapter(tempRoot);
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it('rejects cloud metadata / private IP URLs immediately before any transport call', async () => {
    let transportCalled = false;
    const transportFn: PinnedTransportFn = async () => {
      transportCalled = true;
      throw new Error('should not be called');
    };

    await expect(
      downloadRemoteAsset({
        url: 'http://169.254.169.254/latest/meta-data',
        category: 'videos',
        storage: testStorage,
        transportFn,
      }),
    ).rejects.toThrow('SSRF_PRIVATE_IP');
    expect(transportCalled).toBe(false);
  });

  it('pins the validated safe public IP on DNS rebinding attempts and strips auth headers', async () => {
    const payload = Buffer.from('valid-mp4-bytes');
    const expectedSha = createHash('sha256').update(payload).digest('hex');

    let lookupCalls = 0;
    // First DNS call returns public IP; a hypothetical second unpinned call would rebind to loopback
    const lookupFn = async () => {
      lookupCalls++;
      if (lookupCalls === 1) {
        return [{ address: '93.184.216.34', family: 4 }];
      }
      return [{ address: '127.0.0.1', family: 4 }];
    };

    let receivedIp = '';
    let receivedHeaders: Record<string, string> = {};
    const transportFn: PinnedTransportFn = async (target, opts) => {
      receivedIp = target.resolvedIp;
      receivedHeaders = opts.headers;
      return {
        statusCode: 200,
        headers: { 'content-type': 'video/mp4', 'content-length': String(payload.byteLength) },
        stream: (async function* () {
          yield payload;
        })(),
        destroy: () => undefined,
      };
    };

    const result = await downloadRemoteAsset({
      url: 'https://cdn.runwayml.com/output/video.mp4',
      category: 'videos',
      storage: testStorage,
      lookupFn,
      transportFn,
    });

    // Only one DNS resolution occurred per hop; socket pinned to 93.184.216.34
    expect(lookupCalls).toBe(1);
    expect(receivedIp).toBe('93.184.216.34');
    expect(receivedHeaders.Host).toBe('cdn.runwayml.com');
    expect(receivedHeaders.Authorization).toBeUndefined();
    expect(receivedHeaders.authorization).toBeUndefined();

    expect(result.sha256).toBe(expectedSha);
    expect(result.storagePath).toBe(`videos/${expectedSha}.mp4`);
    expect(await testStorage.verify('videos', `${expectedSha}.mp4`, expectedSha)).toBe(true);
  });

  it('follows valid public redirects up to maxRedirects and blocks redirects to loopback/private IPs', async () => {
    const payload = Buffer.from('redirected-video-bytes');
    const expectedSha = createHash('sha256').update(payload).digest('hex');

    const lookupFn = async (host: string) => {
      if (host === 'cdn.runwayml.com' || host === 'storage.googleapis.com') {
        return [{ address: '34.120.0.1', family: 4 }];
      }
      return [{ address: '127.0.0.1', family: 4 }];
    };

    const goodTransport: PinnedTransportFn = async target => {
      if (target.url.hostname === 'cdn.runwayml.com') {
        return {
          statusCode: 302,
          headers: { location: 'https://storage.googleapis.com/bucket/final.mp4' },
          stream: (async function* () {})(),
          destroy: () => undefined,
        };
      }
      return {
        statusCode: 200,
        headers: { 'content-type': 'video/mp4' },
        stream: (async function* () {
          yield payload;
        })(),
        destroy: () => undefined,
      };
    };

    const okResult = await downloadRemoteAsset({
      url: 'https://cdn.runwayml.com/start.mp4',
      category: 'videos',
      storage: testStorage,
      lookupFn,
      transportFn: goodTransport,
    });
    expect(okResult.sha256).toBe(expectedSha);

    // Redirect targeting loopback must fail closed with SSRF_PRIVATE_IP
    const evilRedirectTransport: PinnedTransportFn = async () => ({
      statusCode: 302,
      headers: { location: 'http://127.0.0.1:5432/dump' },
      stream: (async function* () {})(),
      destroy: () => undefined,
    });

    await expect(
      downloadRemoteAsset({
        url: 'https://cdn.runwayml.com/evil.mp4',
        category: 'videos',
        storage: testStorage,
        lookupFn,
        transportFn: evilRedirectTransport,
      }),
    ).rejects.toThrow('SSRF_PRIVATE_IP');
  });

  it('aborts stream when payload exceeds maxBytes and cleans up temporary files', async () => {
    let destroyed = false;
    const transportFn: PinnedTransportFn = async () => ({
      statusCode: 200,
      headers: { 'content-type': 'video/mp4' }, // omit content-length to test streaming byte counter
      stream: (async function* () {
        yield Buffer.alloc(600);
        yield Buffer.alloc(600); // total 1200 > maxBytes 1024
      })(),
      destroy: () => {
        destroyed = true;
      },
    });

    await expect(
      downloadRemoteAsset({
        url: 'https://cdn.runwayml.com/oversized.mp4',
        category: 'videos',
        maxBytes: 1024,
        storage: testStorage,
        lookupFn: async () => [{ address: '34.120.0.1', family: 4 }],
        transportFn,
      }),
    ).rejects.toThrow('PAYLOAD_TOO_LARGE');

    expect(destroyed).toBe(true);
    const tempFiles = await fs.readdir(testStorage.resolveDir('temp'));
    expect(tempFiles.length).toBe(0);
  });
});
