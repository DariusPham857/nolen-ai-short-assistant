import { expect, test, type Cookie } from '@playwright/test';
import { randomUUID } from 'node:crypto';

const token = 'test-only-operator-token-32-bytes-minimum';
let cookies: Cookie[] = [];

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

test('LP-AT-07: REPLAY keyframe -> LIVE LOCAL_PAN_ZOOM video render -> VideoReviewModal lineage & $0.00 spent', async ({ page }) => {
  test.setTimeout(120000);
  await page.context().addCookies(cookies);

  const filmRes = await page.request.post('/api/films', {
    headers: { Origin: 'http://127.0.0.1:3000', 'Idempotency-Key': randomUUID() },
    data: {
      title: 'LP-001 E2E Film',
      brief: 'Local deterministic pan/zoom vertical workflow verification',
      budgetLimitUsdMicros: '5000000',
      durationTargetSeconds: 45,
      aspectRatio: '9:16',
    },
  });
  expect(filmRes.status()).toBe(201);
  const film = (await filmRes.json()) as { id: string };

  await page.goto(`/films/${film.id}/storyboard`);
  await expect(page.getByRole('heading', { name: 'Story Planning', exact: true })).toBeVisible();

  // 1. Load v2 fixture and approve StoryRevision
  await page.getByRole('button', { name: 'Load 45s fixture proposal', exact: true }).click();
  await expect(page.getByText(/FIXTURE proposal —/)).toBeVisible();
  await page.getByRole('button', { name: 'Save new revision', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Mark planned', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Mark planned', exact: true }).click();
  await expect(page.getByTestId('story-state')).toHaveText('PLANNED');
  await page.getByRole('button', { name: 'Submit for review', exact: true }).click();
  await expect(page.getByTestId('story-state')).toHaveText('IN_REVIEW');
  page.once('dialog', d => d.accept());
  await page.getByRole('button', { name: 'Approve story', exact: true }).click();
  await expect(page.getByTestId('story-state')).toHaveText('APPROVED');

  // 2. Generate REPLAY Keyframe on Shot 1 (auto-opens KeyframeReviewModal on completion) and approve it
  await page.getByRole('button', { name: 'Generate Keyframe', exact: true }).click();
  const kfApproveBtn = page.getByRole('button', { name: 'Approve Keyframe', exact: true });
  await expect(kfApproveBtn).toBeEnabled({ timeout: 30000 });
  await kfApproveBtn.click();
  await expect(page.getByText('✓ Keyframe approved — video generation enabled')).toBeVisible();
  await page.getByRole('button', { name: 'Done', exact: true }).click();

  // 3. Toggle to LIVE mode and verify remote I2V providers are gated
  await page.getByRole('button', { name: 'REPLAY', exact: true }).click();
  await expect(page.getByRole('button', { name: 'LIVE', exact: true })).toBeVisible();
  await expect(page.getByText('LIVE mode supports verified LOCAL_PAN_ZOOM video synthesis only')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Generate Video', exact: true })).toBeDisabled();

  // 4. Select LOCAL_PAN_ZOOM and dispatch LIVE local render
  await page.getByLabel('Provider / Model').selectOption('LOCAL_PAN_ZOOM');
  const genVideoBtn = page.getByRole('button', { name: 'Generate Video', exact: true });
  await expect(genVideoBtn).toBeEnabled({ timeout: 15000 });

  let videoAttemptBody: Record<string, unknown> | null = null;
  await page.route('**/api/films/*/attempts', async route => {
    videoAttemptBody = route.request().postDataJSON() as Record<string, unknown>;
    const realRes = await route.fetch();
    await route.fulfill({ response: realRes });
  });

  await genVideoBtn.click();
  await expect.poll(() => videoAttemptBody).not.toBeNull();
  expect(videoAttemptBody?.executionMode).toBe('LIVE');
  expect(String(videoAttemptBody?.rateCardSnapshotId)).toBe('00000000-0000-4000-a000-000000000005');

  // Wait for worker live:generation:dispatch FFmpeg synthesis completion (auto-opens VideoReviewModal)
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible({ timeout: 45000 });
  await expect(dialog.getByText('LOCAL_PIPELINE')).toBeVisible({ timeout: 15000 });
  await expect(dialog.getByText('(LOCAL_PAN_ZOOM)')).toBeVisible();
  await expect(dialog.getByText('REPLAY_FIXTURE')).toBeVisible();

  const videoEl = dialog.locator('video');
  await expect(videoEl).toBeVisible();
  const videoSrc = await videoEl.getAttribute('src');
  expect(videoSrc).toMatch(/^\/api\/assets\/.+\/media$/);
  const mediaRes = await page.request.get(videoSrc!);
  expect(mediaRes.status()).toBe(200);
  expect(mediaRes.headers()['content-type']).toContain('video/mp4');
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();

  // 6. Verify $0.00 Spent / Reserved / Pending on Budget page
  await page.goto(`/films/${film.id}/budget`);
  await expect(page.getByRole('heading', { name: 'Budget status', exact: true })).toBeVisible();
  const spentCard = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Spent', exact: true }) });
  await expect(spentCard).toContainText('$0.00');
  const reservedCard = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Reserved', exact: true }) });
  await expect(reservedCard).toContainText('$0.00');
});
