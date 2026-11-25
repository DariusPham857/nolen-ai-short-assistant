import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';

const project=process.env.COMPOSE_PROJECT_NAME ?? 'nolen-fc001-review';
/** Operate only the explicitly selected test Compose project. */
function compose(...args){return execFileSync('docker',['compose','-p',project,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();}
const origin='http://127.0.0.1:3000';
/** Poll readiness with a bounded deadline after real container restart. */
async function ready(){for(let i=0;i<60;i++){
  try{
    const res=await fetch(`${origin}/api/health/ready`);
    if(res.ok){
      const body=await res.json();
      if(body?.checks?.database==='connected'&&body?.checks?.storage==='writable')return body;
    }
  }catch{}
  await new Promise(resolve=>setTimeout(resolve,500));
}throw new Error('Web readiness timed out');}
/** Build a minimal 320x320 RGB static PNG using Node zlib for reference upload persistence checks. */
function makeStaticPng320(){
  const w=320,h=320,stride=1+w*3,raw=Buffer.alloc(stride*h);
  for(let y=0;y<h;y++){raw[y*stride]=0;for(let x=0;x<w;x++){const o=y*stride+1+x*3;raw[o]=40;raw[o+1]=120;raw[o+2]=200;}}
  const t=new Uint32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;t[n]=c>>>0;}
  const crc=b=>{let c=0xffffffff;for(const x of b)c=t[(c^x)&0xff]^(c>>>8);return(c^0xffffffff)>>>0;};
  const chunk=(tp,d)=>{const tb=Buffer.from(tp,'ascii'),lb=Buffer.alloc(4),cb=Buffer.alloc(4);lb.writeUInt32BE(d.length,0);cb.writeUInt32BE(crc(Buffer.concat([tb,d])),0);return Buffer.concat([lb,tb,d,cb]);};
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(w,0);ihdr.writeUInt32BE(h,4);ihdr[8]=8;ihdr[9]=2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
}
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
const budgetResponse=await fetch(`${origin}/api/films/${film.id}/budget`,{headers:{Cookie:cookie}});assert.equal(budgetResponse.status,200);const budget=await budgetResponse.json();assert.equal(budget.budgetLimitUsdMicros,'0');
const budgetChange=await fetch(`${origin}/api/films/${film.id}/budget`,{method:'PATCH',headers:{Origin:origin,Cookie:cookie,'Content-Type':'application/json','Idempotency-Key':randomUUID()},body:JSON.stringify({budgetLimitUsdMicros:'1000000',reason:'Compose persistence check',expectedVersion:budget.version})});assert.equal(budgetChange.status,200);
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

// CS-AT-02 & CS-AT-03: verify shared /app/storage between worker and web across restarts
compose('start','worker');
const ratesRes=await fetch(`${origin}/api/rate-cards`,{headers:{Cookie:cookie}});
assert.equal(ratesRes.status,200);
const rates=await ratesRes.json();
const geminiCard=rates.find(r=>r.provider==='GEMINI'&&r.operation==='IMAGE');
assert.ok(geminiCard,'Expected seeded GEMINI IMAGE rate card');
const shotId=persisted.revision.content.scenes[0].shots[0].id;
const shotRevisionId=persisted.revision.shotRevisions[shotId].id;
const previewRes=await fetch(`${origin}/api/films/${film.id}/generation-previews`,{method:'POST',headers:{Origin:origin,Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({storyRevisionId:persisted.active.id,shotRevisionId,kind:'IMAGE',rateCardSnapshotId:geminiCard.id,pricingUnits:1,executionMode:'REPLAY'})});
assert.equal(previewRes.status,200);
const preview=await previewRes.json();
const admitRes=await fetch(`${origin}/api/films/${film.id}/attempts`,{method:'POST',headers:{Origin:origin,Cookie:cookie,'Content-Type':'application/json','Idempotency-Key':randomUUID()},body:JSON.stringify({storyRevisionId:persisted.active.id,shotRevisionId,kind:'IMAGE',rateCardSnapshotId:geminiCard.id,pricingUnits:1,executionMode:'REPLAY',expectedPreviewHash:preview.previewHash})});
assert.equal(admitRes.status,201);
let workerAsset=null;
for(let i=0;i<60;i++){
  const assetsRes=await fetch(`${origin}/api/films/${film.id}/shots/${shotId}/assets`,{headers:{Cookie:cookie}});
  assert.equal(assetsRes.status,200);
  const assets=await assetsRes.json();
  if(assets.length>0){workerAsset=assets[0];break;}
  await new Promise(resolve=>setTimeout(resolve,500));
}
assert.ok(workerAsset,'Expected worker to write REPLAY keyframe asset into shared storage');
const refForm=new FormData();
refForm.set('file',new File([new Uint8Array(makeStaticPng320())],'smoke-ref.png',{type:'image/png'}));
refForm.set('label','Compose Shared Storage Ref');
refForm.set('sourceNote','Smoke persistence check');
refForm.set('rightsConfirmed','true');
const refUploadRes=await fetch(`${origin}/api/films/${film.id}/reference-assets`,{method:'POST',headers:{Origin:origin,Cookie:cookie},body:refForm});
assert.equal(refUploadRes.status,201);
const refAsset=await refUploadRes.json();

async function verifyMedia(mediaUrl,expectedSha){
  const mediaRes=await fetch(`${origin}${mediaUrl}`,{headers:{Cookie:cookie}});
  assert.equal(mediaRes.status,200,`Expected 200 serving ${mediaUrl}, got ${mediaRes.status}`);
  assert.equal(mediaRes.headers.get('etag'),`"${expectedSha}"`);
  const buf=Buffer.from(await mediaRes.arrayBuffer());
  assert.equal(createHash('sha256').update(buf).digest('hex'),expectedSha);
}
await verifyMedia(workerAsset.mediaUrl,workerAsset.sha256Hash);
await verifyMedia(refAsset.mediaUrl,refAsset.sha256Hash);
compose('restart','web','worker');await ready();
await verifyMedia(workerAsset.mediaUrl,workerAsset.sha256Hash);
await verifyMedia(refAsset.mediaUrl,refAsset.sha256Hash);

assert.equal((await fetch(`${origin}/api/operator/session`,{method:'DELETE',headers:{Origin:origin,Cookie:cookie}})).status,204);
compose('restart','web');await ready();
assert.equal((await fetch(`${origin}/api/films/${film.id}`,{headers:{Cookie:cookie}})).status,401);
console.log('PASS: canonical ports, worker-independent Film/Story approval, shared web/worker /app/storage media & persistence across restart');
