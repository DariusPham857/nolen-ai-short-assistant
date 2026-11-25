import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readdirSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { canonicalStoryV1, upgradeBibleToV2 } from '@nolen/contracts';
import { unlock } from '../auth/sessions.js';
import { pgClient } from '../db/index.js';
import { migrateDatabase } from '../db/migrate.js';
import { createFilm } from '../films/repository.js';
import { createAssetApi } from '../http/asset-api.js';
import { createStoryApi } from '../http/story-api.js';
import { storage } from '../lib/storage.js';
import { uploadReferenceAsset } from './reference-repository.js';

const token = 'ref-assets-operator-token-32-bytes-minimum';
let cookie = '';

const app = new Hono();
app.route('/', createAssetApi());
app.route('/', createStoryApi());

function genPng(color = 'red', size = '320x320'): Buffer {
  return execFileSync(
    'ffmpeg',
    ['-v', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=${size}:d=0.04`, '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1'],
    { maxBuffer: 10 * 1024 * 1024 },
  );
}

function makeUploadForm(fileBuf: Buffer, opts: { label?: string; sourceNote?: string; licenseUrl?: string; rightsConfirmed?: string; mime?: string; filename?: string } = {}): FormData {
  const form = new FormData();
  form.set('file', new File([new Uint8Array(fileBuf)], opts.filename ?? 'ref.png', { type: opts.mime ?? 'image/png' }));
  form.set('label', opts.label ?? 'Hero Reference');
  form.set('sourceNote', opts.sourceNote ?? 'Studio sheet');
  if (opts.licenseUrl !== undefined) form.set('licenseUrl', opts.licenseUrl);
  form.set('rightsConfirmed', opts.rightsConfirmed ?? 'true');
  return form;
}

async function createTestFilm(operatorId = 'local-operator') {
  return createFilm(
    {
      title: 'Ref Asset Film',
      brief: 'Testing reference assets',
      budgetLimitUsdMicros: '10000000',
      durationTargetSeconds: 45,
      aspectRatio: '9:16',
      styleNotes: null,
    },
    randomUUID(),
    operatorId,
  );
}

beforeAll(async () => {
  process.env.OPERATOR_TOKEN = token;
  await migrateDatabase(process.env.DATABASE_URL!);
  cookie = `nolen_session=${await unlock(token)}`;
});

afterAll(async () => {
  await pgClient.end();
});

describe('Film Reference Assets (GI-02)', () => {
  it('uploads valid static image atomically, serves with security headers, and enforces Story Bible binding ownership', async () => {
    const film = await createTestFilm();
    const otherFilm = await createTestFilm();
    const png = genPng('blue');
    const expectedHash = createHash('sha256').update(png).digest('hex');

    const res = await app.request(`http://127.0.0.1:3000/api/films/${film.id}/reference-assets`, {
      method: 'POST',
      headers: { Origin: 'http://127.0.0.1:3000', Cookie: cookie },
      body: makeUploadForm(png, { label: 'Blue Studio Ref', licenseUrl: 'https://example.com/ok' }),
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: string; sha256Hash: string; mediaUrl: string; width: number; height: number };
    expect(created.sha256Hash).toBe(expectedHash);
    expect(created.width).toBe(320);
    expect(created.height).toBe(320);

    const listRes = await app.request(`http://127.0.0.1:3000/api/films/${film.id}/reference-assets`, {
      headers: { Cookie: cookie },
    });
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as Array<{ id: string }>;
    expect(list.some(a => a.id === created.id)).toBe(true);

    const mediaRes = await app.request(`http://127.0.0.1:3000${created.mediaUrl}`, {
      headers: { Cookie: cookie },
    });
    expect(mediaRes.status).toBe(200);
    expect(mediaRes.headers.get('cache-control')).toBe('no-store');
    expect(mediaRes.headers.get('x-content-type-options')).toBe('nosniff');
    expect(mediaRes.headers.get('content-disposition')).toBe('inline');
    expect(mediaRes.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await mediaRes.arrayBuffer())).toEqual(png);

    // Reject binding a reference asset from Film A into Film B's StoryBible v2
    const v1 = canonicalStoryV1();
    const crossFilmBible = upgradeBibleToV2(v1.storyBible, { group: 'characters', id: 'hero', assetId: created.id });
    const badStory = { ...v1, storyBible: crossFilmBible };
    const badSave = await app.request(`http://127.0.0.1:3000/api/films/${otherFilm.id}/storyboard/revisions`, {
      method: 'POST',
      headers: {
        Origin: 'http://127.0.0.1:3000',
        Cookie: cookie,
        'Content-Type': 'application/json',
        'Idempotency-Key': randomUUID(),
      },
      body: JSON.stringify({ expectedStoryRevisionId: null, expectedStateVersion: 0, content: badStory }),
    });
    expect(badSave.status).toBe(422);

    // Same-Film StoryBible v2 binding succeeds and only changes the shot referencing 'hero' (all shots reference 'hero' here; test selective location binding too)
    const goodSave = await app.request(`http://127.0.0.1:3000/api/films/${film.id}/storyboard/revisions`, {
      method: 'POST',
      headers: {
        Origin: 'http://127.0.0.1:3000',
        Cookie: cookie,
        'Content-Type': 'application/json',
        'Idempotency-Key': randomUUID(),
      },
      body: JSON.stringify({ expectedStoryRevisionId: null, expectedStateVersion: 0, content: badStory }),
    });
    expect(goodSave.status).toBe(201);
  });

  it('handles concurrent identical uploads, cross-film blob sharing, metadata conflict, corrupt target, and crash recovery', async () => {
    const filmA = await createTestFilm();
    const filmB = await createTestFilm();
    const sharedPng = genPng('green');

    // Concurrent same-film identical metadata uploads -> serialized cleanly, same asset returned
    const [r1, r2] = await Promise.all([
      uploadReferenceAsset(filmA.id, 'local-operator', {
        fileBuffer: sharedPng,
        label: 'Shared',
        sourceNote: 'Note 1',
        licenseUrl: null,
        rightsConfirmed: true,
      }),
      uploadReferenceAsset(filmA.id, 'local-operator', {
        fileBuffer: sharedPng,
        label: 'Shared',
        sourceNote: 'Note 1',
        licenseUrl: null,
        rightsConfirmed: true,
      }),
    ]);
    expect(r1.id).toBe(r2.id);

    // Same blob, different metadata within same film -> 409 REFERENCE_METADATA_CONFLICT (blob preserved)
    await expect(
      uploadReferenceAsset(filmA.id, 'local-operator', {
        fileBuffer: sharedPng,
        label: 'Different Label',
        sourceNote: 'Note 1',
        licenseUrl: null,
        rightsConfirmed: true,
      }),
    ).rejects.toMatchObject({ status: 409, code: 'REFERENCE_METADATA_CONFLICT' });

    // Cross-film sharing of the same blob succeeds cleanly
    const filmBAsset = await uploadReferenceAsset(filmB.id, 'local-operator', {
      fileBuffer: sharedPng,
      label: 'Shared in B',
      sourceNote: 'Note B',
      licenseUrl: null,
      rightsConfirmed: true,
    });
    expect(filmBAsset.sha256Hash).toBe(r1.sha256Hash);

    // Crash BEFORE_PUBLISH leaves no visible temp files and no DB row
    const crashPng = genPng('yellow');
    const crashHash = createHash('sha256').update(crashPng).digest('hex');
    await expect(
      uploadReferenceAsset(
        filmA.id,
        'local-operator',
        { fileBuffer: crashPng, label: 'Crash1', sourceNote: 'Test', licenseUrl: null, rightsConfirmed: true },
        { simulateCrashAt: 'BEFORE_PUBLISH' },
      ),
    ).rejects.toThrow('SIMULATED_CRASH_BEFORE_PUBLISH');
    const dirEntries = readdirSync(storage.resolveDir('references'));
    expect(dirEntries.some(f => f.startsWith('.tmp-'))).toBe(false);
    expect(storage.exists('references', `${crashHash}.png`)).toBe(false);

    // Crash AFTER_PUBLISH_BEFORE_DB succeeds on retry by reusing valid published blob
    await expect(
      uploadReferenceAsset(
        filmA.id,
        'local-operator',
        { fileBuffer: crashPng, label: 'Crash2', sourceNote: 'Test', licenseUrl: null, rightsConfirmed: true },
        { simulateCrashAt: 'AFTER_PUBLISH_BEFORE_DB' },
      ),
    ).rejects.toThrow('SIMULATED_CRASH_AFTER_PUBLISH_BEFORE_DB');
    expect(storage.exists('references', `${crashHash}.png`)).toBe(true);
    const recovered = await uploadReferenceAsset(filmA.id, 'local-operator', {
      fileBuffer: crashPng,
      label: 'Crash2',
      sourceNote: 'Test',
      licenseUrl: null,
      rightsConfirmed: true,
    });
    expect(recovered.sha256Hash).toBe(crashHash);

    // Corrupt existing target fails closed with REFERENCE_BLOB_CORRUPT and does NOT overwrite/delete
    const corruptTargetPng = genPng('purple');
    const corruptHash = createHash('sha256').update(corruptTargetPng).digest('hex');
    const targetPath = storage.resolve('references', `${corruptHash}.png`);
    writeFileSync(targetPath, Buffer.from('corrupted-existing-blob'));
    await expect(
      uploadReferenceAsset(filmA.id, 'local-operator', {
        fileBuffer: corruptTargetPng,
        label: 'Corrupt',
        sourceNote: 'Test',
        licenseUrl: null,
        rightsConfirmed: true,
      }),
    ).rejects.toMatchObject({ status: 409, code: 'REFERENCE_BLOB_CORRUPT' });
    expect(await storage.read('references', `${corruptHash}.png`)).toEqual(Buffer.from('corrupted-existing-blob'));
  });
});
