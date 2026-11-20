import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=fileURLToPath(new URL('..',import.meta.url));
const next=path.join(root,'node_modules/next/dist/bin/next');
/** Finite child build/start; terminate on timeout instead of leaving a server running. */
function run(args,cwd,env,timeout=60000,entry=next){return new Promise((resolve,reject)=>{
  // Next's build workers are applications, not nested node:test workers.
  const childEnv={...env};delete childEnv.NODE_TEST_CONTEXT;
  const child=spawn(process.execPath,[entry,...args],{cwd,env:childEnv,windowsHide:true});let output='';
  child.stdout.on('data',d=>{output+=d;});child.stderr.on('data',d=>{output+=d;});
  const timer=setTimeout(()=>{child.kill();reject(new Error(`Child did not exit: ${output}`));},timeout);
  child.on('error',reject);child.on('exit',code=>{clearTimeout(timer);resolve({code,output});});
});}

test('runtime refuses missing operator token',async()=>{
  const env={...process.env,NEXT_TELEMETRY_DISABLED:'1'};delete env.OPERATOR_TOKEN;
  const result=await run(['--port','3099'],root,env,10000,path.join(root,'scripts/start.mjs'));
  assert.notEqual(result.code,0);assert.match(result.output,/OPERATOR_TOKEN/);
  assert.doesNotMatch(result.output,/Ready in/);
});

test('Next rejects indirect Client Component import through server-only bridge',async()=>{
  const dir=mkdtempSync(path.join(root,'.boundary-'));
  mkdirSync(path.join(dir,'app'));
  mkdirSync(path.join(dir,'lib'));
  writeFileSync(path.join(dir,'package.json'),JSON.stringify({private:true,type:'module'}));
  // Keep fixture diagnostics in this build process instead of nested worker stderr.
  writeFileSync(path.join(dir,'next.config.mjs'),'export default { experimental: { webpackBuildWorker: false } };');
  writeFileSync(path.join(dir,'app/layout.jsx'),'export default function Layout({children}){return <html><body>{children}</body></html>}');
  writeFileSync(path.join(dir,'app/page.jsx'),"'use client'; import { app } from './indirect'; export default function Page(){return <p>{String(!!app)}</p>}");
  writeFileSync(path.join(dir,'lib/server.js'),readFileSync(path.join(root,'lib/server.ts'),'utf8'));
  writeFileSync(path.join(dir,'app/indirect.js'),"export { app } from '../lib/server';");
  const result=await run(['build','--webpack',dir],path.dirname(root.replace(/[\\/]$/,'')),{...process.env,NEXT_TELEMETRY_DISABLED:'1'});
  assert.notEqual(result.code,0);assert.match(result.output,/server-only/);
  assert.match(result.output,/Import trace for requested module/);
  assert.match(result.output,/app[\\/]indirect\.js/);
  assert.match(result.output,/app[\\/]page\.jsx/);
});
