import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const project=process.env.COMPOSE_PROJECT_NAME ?? 'nolen-fc001-review';
/** Operate only the explicitly selected test Compose project. */
function compose(...args){return execFileSync('docker',['compose','-p',project,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();}
const origin='http://127.0.0.1:3000';
/** Poll readiness with a bounded deadline after real container restart. */
async function ready(){for(let i=0;i<60;i++){
  try{if((await fetch(`${origin}/api/health/ready`)).ok)return;}catch{}
  await new Promise(resolve=>setTimeout(resolve,500));
}throw new Error('Web readiness timed out');}
assert.equal(compose('port','web','3000'),'127.0.0.1:3000');
const dbId=compose('ps','-q','db');
const published=JSON.parse(execFileSync('docker',['inspect','--format','{{json .HostConfig.PortBindings}}',dbId],{encoding:'utf8'}));
assert.ok(!published||Object.keys(published).length===0,'Database ports must not be published');
await ready();
const auth=await fetch(`${origin}/api/operator/session`,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({token:process.env.OPERATOR_TOKEN})});
assert.equal(auth.status,204);
const cookie=auth.headers.get('set-cookie').split(';')[0];
compose('stop','worker');
const response=await fetch(`${origin}/api/films`,{method:'POST',headers:{Origin:origin,Cookie:cookie,'Content-Type':'application/json','Idempotency-Key':randomUUID()},body:JSON.stringify({title:'Compose persistence',brief:'Test-owned persistence check',budgetLimitUsdMicros:'0',durationTargetSeconds:45,aspectRatio:'9:16'})});
assert.equal(response.status,201);
const film=await response.json();
const budget=await fetch(`${origin}/api/films/${film.id}/budget`,{headers:{Cookie:cookie}});assert.equal(budget.status,200);assert.equal((await budget.json()).budgetLimitUsdMicros,'0');
const budgetChange=await fetch(`${origin}/api/films/${film.id}/budget`,{method:'PATCH',headers:{Origin:origin,Cookie:cookie,'Content-Type':'application/json','Idempotency-Key':randomUUID()},body:JSON.stringify({budgetLimitUsdMicros:'1000000',reason:'Compose persistence check'})});assert.equal(budgetChange.status,200);
/** Exercise Story without a worker or paid provider, then verify approval across a real restart. */
async function story(route,body){const result=await fetch(`${origin}/api/films/${film.id}/storyboard/${route}`,{method:'POST',headers:{Origin:origin,Cookie:cookie,'Content-Type':'application/json','Idempotency-Key':randomUUID()},body:JSON.stringify(body)});assert.ok(result.ok,`Story ${route}: ${result.status}`);return result.json();}
const initial={expectedStoryRevisionId:null,expectedStateVersion:0};
const proposal=await story('plan-proposals',initial);assert.equal(proposal.provenance.source,'FIXTURE');
let revision=await story('revisions',{...initial,content:proposal.content});
for(const route of ['mark-planned','submit-review','approve'])revision=await story(route,{expectedStoryRevisionId:revision.storyRevisionId,expectedStateVersion:revision.stateVersion});
assert.equal(revision.state,'APPROVED');
compose('restart','web');await ready();
const read=await fetch(`${origin}/api/films/${film.id}`,{headers:{Cookie:cookie}});
assert.equal(read.status,200);assert.equal((await read.json()).id,film.id);
const storyboard=await fetch(`${origin}/api/films/${film.id}/storyboard`,{headers:{Cookie:cookie}});
assert.equal(storyboard.status,200);const persisted=await storyboard.json();assert.equal(persisted.active.state,'APPROVED');assert.equal(persisted.approval.contentHash,revision.contentHash);
const persistedBudget=await fetch(`${origin}/api/films/${film.id}/budget`,{headers:{Cookie:cookie}});assert.equal(persistedBudget.status,200);assert.equal((await persistedBudget.json()).budgetLimitUsdMicros,'1000000');
assert.equal((await fetch(`${origin}/api/operator/session`,{method:'DELETE',headers:{Origin:origin,Cookie:cookie}})).status,204);
compose('restart','web');await ready();
assert.equal((await fetch(`${origin}/api/films/${film.id}`,{headers:{Cookie:cookie}})).status,401);
console.log('PASS: canonical ports, worker-independent Film/Story approval, FI budget persistence, durable logout across restart');
