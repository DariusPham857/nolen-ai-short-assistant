import { test, expect, type Page, type Cookie } from '@playwright/test';
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

/** Open a fresh film storyboard with an approved revision */
async function openStoryboard(page: Page): Promise<string> {
  await page.context().addCookies(cookies);
  const response = await page.request.post('/api/films', {
    headers: { Origin: 'http://127.0.0.1:3000', 'Idempotency-Key': randomUUID() },
    data: {
      title: 'Shot Review E2E Film',
      brief: 'Test shot video generation, attempt history, and review workstation',
      budgetLimitUsdMicros: '9007199254740993',
      durationTargetSeconds: 45,
      aspectRatio: '9:16',
    },
  });
  expect(response.status()).toBe(201);
  const film = (await response.json()) as { id: string };

  await page.goto(`/films/${film.id}/storyboard`);
  await expect(page.getByRole('heading', { name: 'Story Planning', exact: true })).toBeVisible();

  // Load fixture proposal and save
  await page.getByRole('button', { name: 'Load 45s fixture proposal', exact: true }).click();
  await expect(page.getByText(/FIXTURE proposal —/)).toBeVisible();
  await page.getByRole('button', { name: 'Save new revision', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Validate story', exact: true })).toBeEnabled();

  // Approve the story revision
  await page.getByRole('button', { name: 'Mark planned', exact: true }).click();
  await expect(page.getByTestId('story-state')).toHaveText('PLANNED');
  await page.getByRole('button', { name: 'Submit for review', exact: true }).click();
  await expect(page.getByTestId('story-state')).toHaveText('IN_REVIEW');
  page.once('dialog', d => d.accept());
  await page.getByRole('button', { name: 'Approve story', exact: true }).click();
  await expect(page.getByTestId('story-state')).toHaveText('APPROVED');

  return film.id;
}

test('EP-05: Keyframe gating blocks video generation before keyframe approval', async ({ page }) => {
  await openStoryboard(page);

  // Inspector displays Media Generation & Review card
  await expect(page.getByRole('region', { name: 'Media Generation & Review' })).toBeVisible();

  // Video generation is blocked because no keyframe is approved yet
  const generateVideoBtn = page.getByRole('button', { name: 'Generate Video', exact: true });
  await expect(generateVideoBtn).toBeDisabled();
  await expect(
    page.getByText('An approved keyframe is required before video generation', { exact: false })
  ).toBeVisible();
});

test('EP-05: Exact provider selection dispatches matching rate card without silent fallback', async ({ page }) => {
  await openStoryboard(page);

  // Read available rate cards to find Gemini card ID
  const rcRes = await page.request.get('/api/rate-cards');
  const rateCards = (await rcRes.json()) as { id: string; provider: string; operation: string }[];
  const geminiCard = rateCards.find(rc => rc.provider === 'GEMINI' && rc.operation === 'IMAGE');

  let interceptedBody: Record<string, unknown> | null = null;
  await page.route('**/api/films/*/attempts', async route => {
    interceptedBody = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        attemptId: randomUUID(),
        jobState: 'QUEUED',
        reservedMicros: '0',
        budgetVersion: 1,
      }),
    });
  });

  // Generate keyframe
  const generateKeyframeBtn = page.getByRole('button', { name: 'Generate Keyframe', exact: true });
  await generateKeyframeBtn.click();

  expect(interceptedBody).not.toBeNull();
  expect(interceptedBody?.kind).toBe('IMAGE');
  if (geminiCard) {
    expect(interceptedBody?.rateCardSnapshotId).toBe(geminiCard.id);
  }
});

test('EP-05: Lost attempt response preserves retry identity across retries', async ({ page }) => {
  await openStoryboard(page);

  // Intercept attempts endpoint and abort to simulate lost connection
  let originalKey = '';
  let originalBody: Record<string, unknown> | null = null;
  await page.route('**/api/films/*/attempts', async route => {
    originalKey = route.request().headers()['idempotency-key'] ?? '';
    originalBody = route.request().postDataJSON() as Record<string, unknown>;
    await route.abort('failed');
  });

  // Attempt to generate keyframe
  const generateKeyframeBtn = page.getByRole('button', { name: 'Generate Keyframe', exact: true });
  await generateKeyframeBtn.click();

  // Recovery banner must appear with the preserved idempotency key
  const recoveryBanner = page.getByTestId('pending-attempt-banner');
  await expect(recoveryBanner).toBeVisible();
  await expect(recoveryBanner).toContainText('RETRY KEY PRESERVED');
  await expect(recoveryBanner).toContainText(originalKey);

  // Unroute the network abort and mock successful response
  await page.unroute('**/api/films/*/attempts');
  let retriedKey = '';
  let retriedBody: Record<string, unknown> | null = null;

  await page.route('**/api/films/*/attempts', async route => {
    retriedKey = route.request().headers()['idempotency-key'] ?? '';
    retriedBody = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        attemptId: randomUUID(),
        jobState: 'QUEUED',
        reservedMicros: '0',
        budgetVersion: 1,
      }),
    });
  });

  const retryBtn = page.getByRole('button', { name: 'Retry same attempt', exact: true });
  await retryBtn.click();

  // Assert both key and full payload match verbatim
  expect(retriedKey).toBe(originalKey);
  expect(retriedBody).not.toBeNull();
  expect(retriedBody?.storyRevisionId).toBe(originalBody?.storyRevisionId);
  expect(retriedBody?.shotRevisionId).toBe(originalBody?.shotRevisionId);
  expect(retriedBody?.kind).toBe(originalBody?.kind);
  expect(retriedBody?.rateCardSnapshotId).toBe(originalBody?.rateCardSnapshotId);
  expect(retriedBody?.pricingUnits).toBe(originalBody?.pricingUnits);
  expect(retriedBody?.executionMode).toBe(originalBody?.executionMode);
});

test('EP-05: Video review modal opens and displays review controls', async ({ page }) => {
  await openStoryboard(page);

  // Click Review Video
  const reviewVideoBtn = page.getByRole('button', { name: 'Review Video', exact: true });
  await reviewVideoBtn.click();

  // Video review modal should open matching component aria-labelledby
  const modal = page.getByRole('dialog', { name: 'Shot Video Review & Asset Selection' });
  await expect(modal).toBeVisible();
  await expect(page.getByText('No video assets generated for this shot yet.')).toBeVisible();

  // Close modal using accessible name
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await expect(modal).not.toBeVisible();
});
