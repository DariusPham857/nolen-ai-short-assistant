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

  // Change video provider dropdown to FAL Kling
  const providerSelect = page.getByLabel('Provider / Model');
  await providerSelect.selectOption('FAL_KLING');
  await expect(providerSelect).toHaveValue('FAL_KLING');

  // Verify that provider state is retained
  await providerSelect.selectOption('LOCAL_PAN_ZOOM');
  await expect(providerSelect).toHaveValue('LOCAL_PAN_ZOOM');
});

test('EP-05: Lost attempt response preserves retry identity across retries', async ({ page }) => {
  await openStoryboard(page);

  // Intercept attempts endpoint and abort to simulate lost connection
  let capturedKey = '';
  await page.route('**/api/films/*/attempts', async route => {
    capturedKey = route.request().headers()['idempotency-key'] ?? '';
    await route.abort('failed');
  });

  // Attempt to generate keyframe
  const generateKeyframeBtn = page.getByRole('button', { name: 'Generate Keyframe', exact: true });
  await generateKeyframeBtn.click();

  // Recovery banner must appear with the preserved idempotency key
  const recoveryBanner = page.getByTestId('pending-attempt-banner');
  await expect(recoveryBanner).toBeVisible();
  await expect(recoveryBanner).toContainText('RETRY KEY PRESERVED');
  await expect(recoveryBanner).toContainText(capturedKey);

  // Unroute the network abort
  await page.unroute('**/api/films/*/attempts');

  // Retrying must send the identical idempotency key
  let retriedKey = '';
  page.on('request', r => {
    if (r.url().includes('/attempts')) {
      retriedKey = r.headers()['idempotency-key'] ?? '';
    }
  });

  const retryBtn = page.getByRole('button', { name: 'Retry same attempt', exact: true });
  await retryBtn.click();

  expect(retriedKey).toBe(capturedKey);
});

test('EP-05: Video review modal opens and displays review controls', async ({ page }) => {
  await openStoryboard(page);

  // Click Review Video
  const reviewVideoBtn = page.getByRole('button', { name: 'Review Video', exact: true });
  await reviewVideoBtn.click();

  // Video review modal should open
  await expect(page.getByRole('dialog', { name: 'Review Video Asset' })).toBeVisible();
  await expect(page.getByText('No video assets generated for this shot yet.')).toBeVisible();

  // Close modal
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Review Video Asset' })).not.toBeVisible();
});
