import { describe, expect, it } from 'vitest';
import { boundedMultipart } from '../http/boundary.js';
import { runStdinSubprocess, validateStaticReferenceImage } from './media-validation.js';

describe('boundedMultipart', () => {
  it('parses valid multipart upload with quoted boundary and metadata', async () => {
    const form = new FormData();
    form.set('file', new File([Buffer.from('fake-png-bytes')], 'ref "1".png', { type: 'image/png' }));
    form.set('label', 'Hero Reference');
    form.set('sourceNote', 'Studio shoot');
    form.set('licenseUrl', 'https://example.com/license');
    form.set('rightsConfirmed', 'true');

    const req = new Request('http://127.0.0.1:3000/api/films/x/reference-assets', {
      method: 'POST',
      body: form,
    });

    const parsed = await boundedMultipart(req);
    expect(parsed.label).toBe('Hero Reference');
    expect(parsed.sourceNote).toBe('Studio shoot');
    expect(parsed.licenseUrl).toBe('https://example.com/license');
    expect(parsed.rightsConfirmed).toBe(true);
    expect(parsed.fileBuffer.toString('utf8')).toBe('fake-png-bytes');
  });

  it('rejects missing rights confirmation, multiple files, and streaming overflow', async () => {
    const noRights = new FormData();
    noRights.set('file', new File([Buffer.from('abc')], 'a.png', { type: 'image/png' }));
    noRights.set('label', 'Hero');
    noRights.set('sourceNote', 'Note');
    noRights.set('rightsConfirmed', 'false');
    await expect(
      boundedMultipart(new Request('http://127.0.0.1:3000/test', { method: 'POST', body: noRights })),
    ).rejects.toMatchObject({ status: 422, code: 'RIGHTS_CONFIRMATION_REQUIRED' });

    const twoFiles = new FormData();
    twoFiles.append('file', new File([Buffer.from('a')], 'a.png'));
    twoFiles.append('file', new File([Buffer.from('b')], 'b.png'));
    twoFiles.set('label', 'Hero');
    twoFiles.set('sourceNote', 'Note');
    twoFiles.set('rightsConfirmed', 'true');
    await expect(
      boundedMultipart(new Request('http://127.0.0.1:3000/test', { method: 'POST', body: twoFiles })),
    ).rejects.toMatchObject({ status: 422, code: 'VALIDATION_ERROR' });

    // Chunked stream exceeding small body cap without Content-Length header
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(4096));
        controller.enqueue(new Uint8Array(4096));
        controller.close();
      },
    });
    const overReq = new Request('http://127.0.0.1:3000/test', {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=----x' },
      body: stream,
      duplex: 'half',
    } as RequestInit);
    await expect(boundedMultipart(overReq, 5000, 4000)).rejects.toMatchObject({
      status: 413,
      code: 'PAYLOAD_TOO_LARGE',
    });
  });
});

describe('media-validation subprocess failure handling', () => {
  it('returns 503 MEDIA_TOOL_UNAVAILABLE when ffprobe binary does not exist', async () => {
    await expect(
      validateStaticReferenceImage(Buffer.from('abc'), {
        ffprobeBin: 'nonexistent-ffprobe-binary-xyz',
      }),
    ).rejects.toMatchObject({ status: 503, code: 'MEDIA_TOOL_UNAVAILABLE' });
  });

  it('kills subprocess on timeout and detects output overflow', async () => {
    const timed = await runStdinSubprocess(
      process.execPath,
      ['-e', 'setTimeout(()=>{}, 5000)'],
      Buffer.from(''),
      50,
      64 * 1024,
    );
    expect(timed.timedOut).toBe(true);
    expect(timed.signal).toBe('SIGKILL');

    const overflow = await runStdinSubprocess(
      process.execPath,
      ['-e', 'process.stdout.write("x".repeat(512))'],
      Buffer.from(''),
      5000,
      64,
    );
    expect(overflow.outputOverflow).toBe(true);
  });
});
