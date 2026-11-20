import { test, expect, type Page, type Cookie } from '@playwright/test';
import { canonicalStory, type Storyboard } from '@nolen/contracts';
import { randomUUID } from 'node:crypto';
const token='test-only-operator-token-32-bytes-minimum';
let cookies:Cookie[]=[];
test.beforeAll(async({browser})=>{
  test.setTimeout(90000);
  const context=await browser.newContext();const page=await context.newPage();
  try{
  await page.goto('/unlock');await page.getByLabel('Operator token').fill(token);
  const [login]=await Promise.all([page.waitForResponse(r=>r.url().endsWith('/api/operator/session')),page.getByRole('button',{name:'Unlock workspace',exact:true}).click()]);
  // FC tests intentionally consume the limiter. Respect its cooldown; never bypass production auth.
  if(login.status()===429){
    await page.waitForTimeout(Math.min(61,Number(login.headers()['retry-after']??60)+1)*1000);await page.getByRole('button',{name:'Unlock workspace',exact:true}).click();
  }
  await expect(page).toHaveURL(/\/films\/new$/);
  cookies=await context.cookies();
  }finally{await context.close();}
});
/** Reuse one session obtained through the real UI; each test still receives a fresh Film/tab. */
async function open(page:Page){
  await page.context().addCookies(cookies);
  const response=await page.request.post('/api/films',{headers:{Origin:'http://127.0.0.1:3000','Idempotency-Key':randomUUID()},data:{title:'Story browser Film',brief:'The Last Light',budgetLimitUsdMicros:'9007199254740993',durationTargetSeconds:45,aspectRatio:'9:16'}});
  expect(response.status()).toBe(201);const film=await response.json() as {id:string};
  await page.goto(`/films/${film.id}/storyboard`);await expect(page.getByRole('heading',{name:'Story Planning',exact:true})).toBeVisible();return film.id;
}
async function fixture(page:Page){await page.getByRole('button',{name:'Load 45s fixture proposal',exact:true}).click();await expect(page.getByText(/FIXTURE proposal —/)).toBeVisible();}
async function save(page:Page){await page.getByRole('button',{name:'Save new revision',exact:true}).click();await expect(page.getByRole('button',{name:'Validate story',exact:true})).toBeEnabled();}

test('canonical 45s/eight-shot approval persists; edits fork history, mobile remains usable',async({page})=>{
  const id=await open(page);await fixture(page);
  await expect(page.getByText('45s · 8 shots · 9:16',{exact:true})).toBeVisible();await save(page);
  await expect(page.getByText('Keyframe: REQUIRED',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Mark planned',exact:true}).click();await expect(page.getByTestId('story-state')).toHaveText('PLANNED');
  await page.getByRole('button',{name:'Submit for review',exact:true}).click();await expect(page.getByTestId('story-state')).toHaveText('IN_REVIEW');
  page.once('dialog',d=>d.accept());await page.getByRole('button',{name:'Approve story',exact:true}).click();
  await expect(page.getByTestId('story-state')).toHaveText('APPROVED');await page.reload();await expect(page.getByTestId('story-state')).toHaveText('APPROVED');
  await page.screenshot({path:test.info().outputPath('story-approved-desktop.png'),fullPage:true});
  await page.getByLabel('Shot prompt',{exact:true}).fill('Updated shot after approval');await save(page);
  await expect(page.getByTestId('story-state')).toHaveText('DRAFT');
  await page.getByRole('button',{name:'Revision 1 · APPROVED',exact:true}).click();
  await expect(page.getByTestId('story-state')).toHaveText('History · APPROVED');await expect(page.getByLabel('Shot prompt',{exact:true})).toBeDisabled();
  await page.getByRole('button',{name:'Reload current revision',exact:true}).click();await expect(page.getByLabel('Shot prompt',{exact:true})).toHaveValue('Updated shot after approval');
  await page.setViewportSize({width:390,height:844});await expect(page.getByRole('button',{name:'Move shot down',exact:true})).toBeVisible();
  await page.screenshot({path:test.info().outputPath('story-mobile.png'),fullPage:true});
  const read=await page.request.get(`/api/films/${id}/storyboard`);const board=await read.json() as Storyboard;expect(board.history).toHaveLength(2);
});

test('lost response preserves pending key/payload across reload and retry creates no duplicate revision',async({page})=>{
  const id=await open(page);await fixture(page);let key='';
  await page.route('**/storyboard/revisions',async route=>{key=route.request().headers()['idempotency-key'];await route.fetch();await route.abort();});
  await page.getByRole('button',{name:'Save new revision',exact:true}).click();await expect(page.getByRole('button',{name:'Retry same request',exact:true})).toBeEnabled();
  await page.unroute('**/storyboard/revisions');await page.reload();await expect(page.getByRole('button',{name:'Retry same request',exact:true})).toBeEnabled();
  let retry='';page.on('request',r=>{if(r.url().endsWith('/storyboard/revisions'))retry=r.headers()['idempotency-key'];});
  await page.getByRole('button',{name:'Retry same request',exact:true}).click();await expect(page.getByRole('button',{name:'Validate story',exact:true})).toBeEnabled();expect(retry).toBe(key);
  const board=await (await page.request.get(`/api/films/${id}/storyboard`)).json() as Storyboard;expect(board.history).toHaveLength(1);
});

test('stale external write rejects save without losing draft; manual planning, duplicate/remove/reorder controls work',async({page})=>{
  const id=await open(page);await page.getByRole('button',{name:'Start manual plan',exact:true}).click();await save(page);
  await page.getByRole('button',{name:'Duplicate shot',exact:true}).click();await expect(page.getByText('60s · 2 shots · 9:16',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Move shot down',exact:true}).click();await page.getByRole('button',{name:'Remove shot',exact:true}).click();
  await page.getByLabel('Shot prompt',{exact:true}).fill('Keep my unsaved draft');
  const board=await (await page.request.get(`/api/films/${id}/storyboard`)).json() as Storyboard;
  const external=await page.request.post(`/api/films/${id}/storyboard/revisions`,{headers:{Origin:'http://127.0.0.1:3000','Idempotency-Key':randomUUID()},data:{expectedStoryRevisionId:board.active!.id,expectedStateVersion:board.active!.stateVersion,content:canonicalStory()}});expect(external.status()).toBe(201);
  await page.getByRole('button',{name:'Save new revision',exact:true}).click();await expect(page.getByRole('alert').filter({hasText:'Reload the current storyboard'})).toContainText(/Reload/);
  await expect(page.getByLabel('Shot prompt',{exact:true})).toHaveValue('Keep my unsaved draft');await page.reload();await expect(page.getByLabel('Shot prompt',{exact:true})).toHaveValue('Keep my unsaved draft');
});
