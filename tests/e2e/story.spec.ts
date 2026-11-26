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
  await expect(page.getByText('Keyframe: REQUIRED',{exact:true})).toBeVisible();await expect(page.getByText('No blocking findings under story-approval-2.',{exact:true})).toBeVisible();
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
  const read=await page.request.get(`/api/films/${id}/storyboard`);const board=await read.json() as Storyboard;expect(board.history).toHaveLength(2);expect(board.currentRuleSetVersion).toBe('story-approval-2');
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
  await page.getByRole('button',{name:'Move shot down',exact:true}).focus();await page.keyboard.press('Enter');await page.getByRole('button',{name:'Remove shot',exact:true}).click();
  await page.getByLabel('Shot prompt',{exact:true}).fill('Keep my unsaved draft');
  const board=await (await page.request.get(`/api/films/${id}/storyboard`)).json() as Storyboard;
  const external=await page.request.post(`/api/films/${id}/storyboard/revisions`,{headers:{Origin:'http://127.0.0.1:3000','Idempotency-Key':randomUUID()},data:{expectedStoryRevisionId:board.active!.id,expectedStateVersion:board.active!.stateVersion,content:canonicalStory()}});expect(external.status()).toBe(201);
  await page.getByRole('button',{name:'Save new revision',exact:true}).click();await expect(page.getByRole('alert').filter({hasText:'Reload the current storyboard'})).toContainText(/Reload/);
  await expect(page.getByLabel('Shot prompt',{exact:true})).toHaveValue('Keep my unsaved draft');await page.reload();await expect(page.getByLabel('Shot prompt',{exact:true})).toHaveValue('Keep my unsaved draft');
});

test('5xx after Story commit retains the same key and payload until a definite replay response',async({page})=>{
  const id=await open(page);await fixture(page);let key='';
  await page.route('**/storyboard/revisions',async route=>{key=route.request().headers()['idempotency-key'];const committed=await route.fetch();expect(committed.status()).toBe(201);await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'DATABASE_UNAVAILABLE',message:'Test response lost after commit',requestId:'test-only'}})});});
  await page.getByRole('button',{name:'Save new revision',exact:true}).click();await expect(page.getByRole('button',{name:'Retry same request',exact:true})).toBeEnabled();
  await page.unroute('**/storyboard/revisions');let replayKey='';page.on('request',r=>{if(r.url().endsWith('/storyboard/revisions'))replayKey=r.headers()['idempotency-key'];});
  await page.getByRole('button',{name:'Retry same request',exact:true}).click();await expect(page.getByRole('button',{name:'Validate story',exact:true})).toBeEnabled();expect(replayKey).toBe(key);
  const board=await(await page.request.get(`/api/films/${id}/storyboard`)).json() as Storyboard;expect(board.history).toHaveLength(1);
});

test('Gemini proposal loads LIVE_LLM provenance, preserves draft on error, survives reload, marks findings stale on edit, and saves without auto-approve (FP-AT-05)',async({page})=>{
  const id=await open(page);
  // Start manual plan and save so we have a baseline, then edit or start fresh
  await page.getByRole('button',{name:'Start manual plan',exact:true}).click();
  await page.getByLabel('Shot prompt',{exact:true}).fill('Draft before Gemini error');

  // Generate button is locked when dirty
  await expect(page.getByRole('button',{name:'Generate story with Gemini',exact:true})).toBeDisabled();
  await save(page);
  await expect(page.getByRole('button',{name:'Generate story with Gemini',exact:true})).toBeEnabled();

  // Error preserves existing saved/loaded draft
  await page.route('**/storyboard/plan-proposals',async route=>{
    const body=route.request().postDataJSON() as {mode?:string};
    expect(body.mode).toBe('GEMINI_FREE_PLANNER');
    await route.fulfill({status:422,contentType:'application/json',body:JSON.stringify({error:{code:'FREE_PLANNER_BILLING_UNATTESTED',message:'Attestation required',requestId:'test-only'}})});
  });
  await page.getByRole('button',{name:'Generate story with Gemini',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('Attestation required');
  await expect(page.getByLabel('Shot prompt',{exact:true})).toHaveValue('Draft before Gemini error');
  await page.unroute('**/storyboard/plan-proposals');

  // Successful Gemini proposal
  await page.route('**/storyboard/plan-proposals',async route=>{
    await route.fulfill({
      status:200,
      contentType:'application/json',
      body:JSON.stringify({
        provenance:{source:'LIVE_LLM',model:'gemini-3.5-flash-lite',liveInference:true},
        content:canonicalStory(),
        findings:[{fingerprint:'a'.repeat(64),code:'TARGET_DURATION',severity:'WARNING',path:'duration',message:'Total 45s sample finding',waivable:false}],
      }),
    });
  });
  await page.getByRole('button',{name:'Generate story with Gemini',exact:true}).click();
  await expect(page.getByTestId('proposal-banner')).toContainText('LIVE_LLM proposal · gemini-3.5-flash-lite · liveInference: true');
  await expect(page.getByTestId('proposal-banner')).toContainText('TARGET_DURATION');
  await page.unroute('**/storyboard/plan-proposals');

  // Survives reload
  await page.reload();
  await expect(page.getByTestId('proposal-banner')).toContainText('LIVE_LLM proposal · gemini-3.5-flash-lite · liveInference: true');
  await expect(page.getByTestId('proposal-banner')).toContainText('TARGET_DURATION');

  // Editing marks findings stale and locks Gemini button
  await page.getByLabel('Shot prompt',{exact:true}).fill('Edited Gemini shot prompt');
  await expect(page.getByTestId('proposal-banner')).toContainText('stale (edited since proposal)');
  await expect(page.getByRole('button',{name:'Generate story with Gemini',exact:true})).toBeDisabled();

  // Saving sends clean saveStorySchema without auto-approve and clears proposal banner
  await save(page);
  await expect(page.getByTestId('proposal-banner')).toHaveCount(0);
  await expect(page.getByTestId('story-state')).toHaveText('DRAFT');
  const board=await(await page.request.get(`/api/films/${id}/storyboard`)).json() as Storyboard;
  expect(board.history).toHaveLength(2);
});

test('Gemini proposal locks workspace with storageBlocked when sessionStorage.setItem fails (FP-AT-05b)',async({page})=>{
  await open(page);
  await page.getByRole('button',{name:'Start manual plan',exact:true}).click();
  await page.getByLabel('Shot prompt',{exact:true}).fill('Saved before quota error');
  await save(page);

  await page.route('**/storyboard/plan-proposals',async route=>{
    await route.fulfill({
      status:200,
      contentType:'application/json',
      body:JSON.stringify({
        provenance:{source:'LIVE_LLM',model:'gemini-3.5-flash-lite',liveInference:true},
        content:canonicalStory(),
        findings:[],
      }),
    });
  });

  await page.evaluate(()=>{
    const orig=Storage.prototype.setItem;
    Storage.prototype.setItem=function(k:string,v:string){
      if(k.endsWith('-draft'))throw new DOMException('Quota exceeded','QuotaExceededError');
      return orig.call(this,k,v);
    };
  });

  await page.getByRole('button',{name:'Generate story with Gemini',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('Tab storage is unavailable. Restore storage before sending changes.');
  await expect(page.getByRole('button',{name:'Discard local state',exact:true})).toBeEnabled();
  await expect(page.getByLabel('Shot prompt',{exact:true})).toBeDisabled();
  await expect(page.getByLabel('Shot prompt',{exact:true})).toHaveValue('Saved before quota error');
  await page.unroute('**/storyboard/plan-proposals');
});
