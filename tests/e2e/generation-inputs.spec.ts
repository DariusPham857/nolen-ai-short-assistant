import { test, expect, type Cookie } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';

const token = 'test-only-operator-token-32-bytes-minimum';
let cookies: Cookie[] = [];

/** Builds a minimal valid 320x320 RGB static PNG without requiring host ffmpeg binary. */
function makeStaticPng320(): Buffer {
  const width = 320;
  const height = 320;
  const stride = 1 + width * 3;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0; // filter None
    for (let x = 0; x < width; x++) {
      const off = y * stride + 1 + x * 3;
      raw[off] = 40;
      raw[off + 1] = 120;
      raw[off + 2] = 200;
    }
  }
  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc32 = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const typeBuf = Buffer.from(type, 'ascii');
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(data.length, 0);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(90000);
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto('/unlock');
    await page.getByLabel('Operator token').fill(token);
    const [login] = await Promise.all([
      page.waitForResponse(r => r.url().endsWith('/api/operator/session')),
      page.getByRole('button', { name: 'Unlock workspace', exact: true }).click(),
    ]);
    if (login.status() === 429) {
      await page.waitForTimeout(Math.min(61, Number(login.headers()['retry-after'] ?? 60) + 1) * 1000);
      await page.getByRole('button', { name: 'Unlock workspace', exact: true }).click();
    }
    await expect(page).toHaveURL(/\/films\/new$/);
    cookies = await context.cookies();
  } finally {
    await context.close();
  }
});

test('GI-AT-11: upload reference -> bind to Bible -> set camera angle -> approve -> preview compiled input -> generate Replay', async ({ page }) => {
  await page.context().addCookies(cookies);
  const filmRes = await page.request.post('/api/films', {
    headers: { Origin: 'http://127.0.0.1:3000', 'Idempotency-Key': randomUUID() },
    data: {
      title: 'GI-001 E2E Film',
      brief: 'Reference library and authoritative preview test',
      budgetLimitUsdMicros: '5000000',
      durationTargetSeconds: 45,
      aspectRatio: '9:16',
    },
  });
  expect(filmRes.status()).toBe(201);
  const film = (await filmRes.json()) as { id: string };

  await page.goto(`/films/${film.id}/storyboard`);
  await expect(page.getByRole('heading', { name: 'Story Planning', exact: true })).toBeVisible();

  // 1. Load v2 fixture proposal
  await page.getByRole('button', { name: 'Load 45s fixture proposal', exact: true }).click();
  await expect(page.getByText(/FIXTURE proposal —/)).toBeVisible();

  // 2. Upload valid static PNG reference image
  const pngBuffer = makeStaticPng320();
  await page.locator('input[type="file"]').setInputFiles({
    name: 'hero-ref.png',
    mimeType: 'image/png',
    buffer: pngBuffer,
  });
  await page.getByLabel('Reference label', { exact: true }).fill('Hero Portrait');
  await page.getByLabel('Source note', { exact: true }).fill('Author studio portrait');
  await page.getByLabel('I confirm commercial/reference usage rights').check();
  await page.getByRole('button', { name: 'Upload reference', exact: true }).click();
  await expect(page.getByText('Hero Portrait', { exact: true })).toBeVisible();

  // 3. Bind reference to Hero character in Story Bible
  const charBindBtn = page.getByRole('button', { name: 'Bind reference', exact: true }).first();
  await charBindBtn.click();
  await expect(page.getByText('Bound references (1)')).toBeVisible();

  // 4. Select camera angle LOW_ANGLE on Shot 1
  await page.getByLabel('Camera angle', { exact: true }).selectOption('LOW_ANGLE');

  // 5. Save and approve story revision
  await page.getByRole('button', { name: 'Save new revision', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Validate story', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Mark planned', exact: true }).click();
  await expect(page.getByTestId('story-state')).toHaveText('PLANNED');
  await page.getByRole('button', { name: 'Submit for review', exact: true }).click();
  await expect(page.getByTestId('story-state')).toHaveText('IN_REVIEW');
  page.once('dialog', d => d.accept());
  await page.getByRole('button', { name: 'Approve story', exact: true }).click();
  await expect(page.getByTestId('story-state')).toHaveText('APPROVED');

  // 6. Verify authoritative server preview includes LOW_ANGLE, Hero, and bound reference
  const previewPanel = page.getByTestId('image-preview-panel');
  await expect(previewPanel).toBeVisible();
  await expect(previewPanel).toContainText('angle=LOW_ANGLE');
  await expect(previewPanel).toContainText('CHARACTER_REFERENCE');

  // 7. Dispatch Replay generation and verify expectedPreviewHash is sent
  let admittedBody: Record<string, unknown> | null = null;
  await page.route('**/api/films/*/attempts', async route => {
    admittedBody = route.request().postDataJSON() as Record<string, unknown>;
    const realRes = await route.fetch();
    await route.fulfill({ response: realRes });
  });

  await page.getByRole('button', { name: 'Generate Keyframe', exact: true }).click();
  await expect.poll(() => admittedBody).not.toBeNull();
  expect(String(admittedBody?.expectedPreviewHash ?? '')).toMatch(/^[a-f0-9]{64}$/);
});
