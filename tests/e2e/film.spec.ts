import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
const token='test-only-operator-token-32-bytes-minimum';

/** Use the actual unlock form, never inject authenticated state into the app. */
async function unlock(page:import('@playwright/test').Page) {
  await page.goto('/unlock');await page.getByLabel('Operator token').fill(token);
  await page.getByRole('button',{name:'Unlock workspace',exact:true}).click();
  await expect(page).toHaveURL(/\/films\/new$/);
}
/** Populate the real production form. */
async function fill(page:import('@playwright/test').Page,title:string) {
  await page.getByLabel('Film title').fill(title);
  await page.getByLabel('Production brief').fill('A product walks through a quiet scene.');
  await page.getByLabel('Budget limit (USD)').fill('9007199254.740993');
}

test('unlock, create, reload, logout and copied-cookie replay',async({page,request})=>{
  await unlock(page);await fill(page,'Persistent Film');
  await page.getByRole('button',{name:'Create draft Film'}).click();
  await expect(page).toHaveURL(/\/films\/[0-9a-f-]+\/brief$/);
  await expect(page.getByRole('heading',{name:'Persistent Film'})).toBeVisible();
  await expect(page.getByText('Budget limit: $9007199254.740993')).toBeVisible();
  await page.screenshot({path:test.info().outputPath('film-brief.png'),fullPage:true});
  const url=page.url(); await page.reload();
  await expect(page.getByRole('heading',{name:'Persistent Film'})).toBeVisible();
  const cookies=await page.context().cookies();
  const old=cookies.find(c=>c.name==='nolen_session')!;
  await page.getByRole('button',{name:'Lock workspace'}).click();
  await expect(page).toHaveURL(/\/unlock$/);
  const response=await request.get(`/api/films/${url.split('/')[4]}`,{headers:{Cookie:`nolen_session=${old.value}`}});
  expect(response.status()).toBe(401);
});

test('response lost after commit retains pending state across reload and retries same Film',async({page})=>{
  await unlock(page);await fill(page,'Uncertain Film');
  let createdId='';let key='';
  await page.route('**/api/films',async route=>{
    key=route.request().headers()['idempotency-key'];
    const response=await route.fetch();
    const body=await response.json() as {id:string};createdId=body.id;
    await route.abort('failed');
  },{times:1});
  await page.getByRole('button',{name:'Create draft Film'}).click();
  await expect(page.getByRole('alert',{name:'Create Film error'})).toContainText('Creation is not confirmed');
  await page.reload();await expect(page.getByRole('heading',{name:'Unconfirmed create request'})).toBeVisible();
  const retry=page.waitForRequest(r=>r.url().endsWith('/api/films')&&r.method()==='POST');
  await page.getByRole('button',{name:'Retry saved request'}).click();
  expect((await retry).headers()['idempotency-key']).toBe(key);
  await expect(page).toHaveURL(new RegExp(`/films/${createdId}/brief$`));
  expect(await page.evaluate(()=>sessionStorage.getItem('nolen-pending-film'))).toBeNull();
});

test('5xx after commit remains uncertain and is retried with original key',async({page})=>{
  await unlock(page);await fill(page,'Server response uncertain');
  let id='';
  await page.route('**/api/films',async route=>{
    const response=await route.fetch();id=(await response.json() as {id:string}).id;
    await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'DATABASE_UNAVAILABLE',message:'Storage unavailable',requestId:randomUUID()}})});
  },{times:1});
  await page.getByRole('button',{name:'Create draft Film'}).click();
  await expect(page.getByRole('button',{name:'Retry saved request'})).toBeVisible();
  await page.getByRole('button',{name:'Retry saved request'}).click();
  await expect(page).toHaveURL(new RegExp(`/films/${id}/brief$`));
});

test('bigint overflow rejected before request and narrow screen remains usable',async({page})=>{
  await unlock(page);await page.setViewportSize({width:390,height:844});
  await fill(page,'Overflow');await page.getByLabel('Budget limit (USD)').fill('9223372036854.775808');
  let submitted=false;page.on('request',r=>{if(r.url().endsWith('/api/films')&&r.method()==='POST')submitted=true;});
  await page.getByRole('button',{name:'Create draft Film'}).click();
  await expect(page.getByRole('alert',{name:'Create Film error'})).toContainText('Budget');expect(submitted).toBe(false);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await page.screenshot({path:test.info().outputPath('create-mobile.png'),fullPage:true});
});

test('definitive validation refusal preserves form values for correction',async({page})=>{
  await unlock(page);await fill(page,'Preserved draft');
  await page.route('**/api/films',route=>route.fulfill({status:422,contentType:'application/json',body:JSON.stringify({error:{code:'VALIDATION_ERROR',message:'Check the submitted fields',requestId:randomUUID()}})}),{times:1});
  await page.getByRole('button',{name:'Create draft Film'}).click();
  await expect(page.getByRole('alert',{name:'Create Film error'})).toContainText('Check');
  await expect(page.getByLabel('Film title')).toHaveValue('Preserved draft');
  await expect(page.getByLabel('Budget limit (USD)')).toHaveValue('9007199254.740993');
});
