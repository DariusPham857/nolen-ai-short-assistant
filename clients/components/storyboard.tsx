'use client';
import { useEffect, useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { expectedSchema, filmDtoSchema, formatMicros, saveStorySchema, storyContentSchema, type Expected, type Storyboard, type StoryContent, type ShotSpec } from '@nolen/contracts';
import { Button } from './ui/button';
import { Navigation } from './navigation';
import { errorMessage } from '../lib/api';

type Pending={key:string;route:string;body:unknown};
const routes=['revisions','mark-planned','submit-review','approve','waivers'];
const inputClass='w-full rounded border border-zinc-700 bg-zinc-950 p-2 text-sm text-zinc-100';
/** Small labeled editor reused for creative prose; no implementation fields exposed. */
function Field({label,value,onChange,multiline=false}:{label:string;value:string;onChange:(value:string)=>void;multiline?:boolean}){
  const id=useId();
  return <div className="text-xs text-zinc-400 space-y-1"><label htmlFor={id}>{label}</label>{multiline?<textarea id={id} className={inputClass} rows={3} value={value} onChange={e=>onChange(e.target.value)}/>:<input id={id} className={inputClass} value={value} onChange={e=>onChange(e.target.value)}/>}</div>;
}
/** Initial manual intent is visibly editable and carries no AI/provider provenance. */
function manualStory(brief:string):StoryContent {
  const state={locationId:'location',lighting:'Daylight',propIds:[],characterStates:[]};
  return storyContentSchema.parse({script:brief,storyBible:{schemaVersion:'1',narrative:'Describe the visual direction',characters:[],wardrobes:[],props:[],locations:[{id:'location',name:'Location',description:'Describe the location'}],styleRefs:[{id:'style',name:'Style',description:'Describe the visual style'}]},scenes:[{clientRef:'scene-1',title:'Scene 1',shots:[{clientRef:'shot-1',spec:{shotType:'ESTABLISHING',durationSeconds:30,prompt:brief,camera:{framing:'Wide',movement:'Static'},styleRefId:'style',subjectIds:[],locationId:'location',continuity:{start:state,end:state}}}]}]});
}
/** Restore only recognized command routes and request identities from tab-local storage. */
function pendingFrom(raw:string):Pending {
  const p:unknown=JSON.parse(raw);
  if(!p||typeof p!=='object'||!('route'in p)||typeof p.route!=='string'||!routes.includes(p.route)||!('key'in p)||typeof p.key!=='string'||!/^[\da-f-]{36}$/i.test(p.key)||!('body'in p))throw new Error('Unreadable pending command');
  return {route:p.route,key:p.key,body:p.body};
}
/** Three-pane G1 editor; uncertain commands retain exact payload/key until a definite response. */
export function StoryboardWorkspace({filmId}:{filmId:string}){
  const router=useRouter();const base=`/api/films/${filmId}`;const slot=`nolen-story-${filmId}`;
  const [board,setBoard]=useState<Storyboard|null>(null);const [content,setContent]=useState<StoryContent|null>(null);
  const [token,setToken]=useState<Expected>({expectedStoryRevisionId:null,expectedStateVersion:0});
  const [budget,setBudget]=useState('');const [error,setError]=useState('');const [busy,setBusy]=useState(false);const [dirty,setDirty]=useState(false);
  const [pending,setPending]=useState<Pending|null>(null);const [storageBlocked,setStorageBlocked]=useState(false);const [historical,setHistorical]=useState(false);
  const [selected,setSelected]=useState({scene:0,shot:0});const [proposal,setProposal]=useState(false);

  /** Reload authoritative state; populate expected Shot tokens for subsequent full-snapshot save. */
  async function load(revisionId?:string,restore=false){
    const response=await fetch(`${base}/storyboard${revisionId?`/revisions/${revisionId}`:''}`,{cache:'no-store'});
    if(response.status===401){router.push(`/unlock?next=/films/${filmId}/storyboard`);return;}
    if(!response.ok)throw new Error(await errorMessage(response));
    const b=await response.json() as Storyboard;setBoard(b);setHistorical(Boolean(revisionId));setSelected({scene:0,shot:0});setProposal(false);
    const r=b.revision;let next=r?structuredClone(r.content):null;
    if(next&&r)for(const s of next.scenes.flatMap(s=>s.shots))s.expectedShotRevisionId=r.shotRevisions[s.id!].id;
    let expected={expectedStoryRevisionId:b.active?.id??null,expectedStateVersion:b.active?.stateVersion??0};let restored=false;
    if(restore){const raw=sessionStorage.getItem(`${slot}-draft`);if(raw){const parsed=saveStorySchema.parse(JSON.parse(raw) as unknown);next=parsed.content;expected=expectedSchema.parse({expectedStoryRevisionId:parsed.expectedStoryRevisionId,expectedStateVersion:parsed.expectedStateVersion});restored=true;}}
    setContent(next);setToken(expected);setDirty(restored);
  }
  useEffect(()=>{void(async()=>{
    try{
      const raw=sessionStorage.getItem(`${slot}-pending`);if(raw)setPending(pendingFrom(raw));
      await load(undefined,true);
      const response=await fetch(base,{cache:'no-store'});if(response.ok)setBudget(filmDtoSchema.parse(await response.json()).budgetLimitUsdMicros);
    }catch{setStorageBlocked(true);setError('Unable to restore the workspace. Reload or explicitly discard stored state.');}
  })();},[filmId]);

  /** Draft persistence happens before the next network operation, preserving unsaved work on reload. */
  function edit(change:(draft:StoryContent)=>void){
    if(!content)return;const next=structuredClone(content);change(next);setContent(next);setDirty(true);
    try{sessionStorage.setItem(`${slot}-draft`,JSON.stringify({...token,content:next}));}catch{setStorageBlocked(true);setError('Tab storage is unavailable. Restore storage before sending changes.');}
  }
  async function send(p:Pending){
    setBusy(true);setError('');
    try{
      const response=await fetch(`${base}/storyboard/${p.route}`,{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':p.key},body:JSON.stringify(p.body)});
      if(response.status>=500){setError(`${await errorMessage(response)} Outcome is uncertain; retry the same request.`);return;}
      sessionStorage.removeItem(`${slot}-pending`);setPending(null);
      if(!response.ok){setError(await errorMessage(response));return;}
      sessionStorage.removeItem(`${slot}-draft`);await load();
    }catch{setError('Connection lost. Outcome is uncertain; retry the same request.');}
    finally{setBusy(false);}
  }
  function mutate(route:string,body:unknown){
    const p={key:crypto.randomUUID(),route,body};
    try{sessionStorage.setItem(`${slot}-pending`,JSON.stringify(p));setPending(p);void send(p);}catch{setStorageBlocked(true);setError('Cannot persist retry identity; nothing was sent.');}
  }
  async function fixture(){
    setBusy(true);setError('');try{
      const response=await fetch(`${base}/storyboard/plan-proposals`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(token)});
      if(!response.ok)throw new Error(await errorMessage(response));
      const result=await response.json() as {content:unknown};const next=storyContentSchema.parse(result.content);setContent(next);setDirty(true);setProposal(true);setSelected({scene:0,shot:0});
      sessionStorage.setItem(`${slot}-draft`,JSON.stringify({...token,content:next}));
    }catch(e){setError(e instanceof Error?e.message:'Unable to load fixture');}finally{setBusy(false);}
  }
  async function revalidate(){
    setBusy(true);setError('');try{
      const response=await fetch(`${base}/continuity/validate`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...token,context:'STORY_APPROVAL'})});
      if(!response.ok)throw new Error(await errorMessage(response));await load();
    }catch(e){setError(e instanceof Error?e.message:'Validation unavailable');}finally{setBusy(false);}
  }
  /** Explicit abandonment acknowledges that an uncertain command may already have committed. */
  function discard(){if(window.confirm('Discard local work and pending request? An uncertain request may already have saved a revision. Reload the server state to reconcile.')){
    try{sessionStorage.removeItem(`${slot}-pending`);sessionStorage.removeItem(`${slot}-draft`);setPending(null);setStorageBlocked(false);void load().catch(()=>setError('Reload failed.'));}catch{setError('Storage is still unavailable.');}
  }}
  const disabled=busy||Boolean(pending)||storageBlocked||historical;
  const historicalValidation=Boolean(board?.validation&&board.validation.ruleSetVersion!==board.currentRuleSetVersion);
  const shot=content?.scenes[selected.scene]?.shots[selected.shot];
  const updateShot=(f:(s:ShotSpec)=>void)=>edit(c=>f(c.scenes[selected.scene].shots[selected.shot].spec));
  const total=content?.scenes.flatMap(s=>s.shots).reduce((n,s)=>n+s.spec.durationSeconds,0)??0;
  if(!board&&!error)return <div role="status" className="h-64 animate-pulse bg-zinc-900 rounded">Loading storyboard…</div>;
  return <div data-story-workspace>
    <header className="sticky top-0 z-10 bg-zinc-950 py-4 border-b border-zinc-800 space-y-3"><div className="flex justify-between gap-4 flex-wrap"><h1 className="text-2xl font-bold">Story Planning</h1><Navigation/></div>
      <div className="flex flex-wrap gap-4 text-sm"><span data-testid="story-state">{historical?'History · ':''}{board?.revision?.state??'No plan'}</span><span className="font-mono">{total}s · {content?.scenes.flatMap(s=>s.shots).length??0} shots · 9:16</span>{budget&&<span>Budget limit: ${formatMicros(budget)}</span>}<span role="status">{pending?'Uncertain / pending':dirty?'Unsaved changes':'Saved'}</span></div>
    </header>
    {error&&<p role="alert" className="my-4 text-rose-300">{error}</p>}
    {(pending||storageBlocked)&&<div className="my-4 flex gap-3"><Button disabled={busy||!pending} onClick={()=>pending&&void send(pending)}>Retry same request</Button><Button variant="outline" onClick={discard}>Discard local state</Button></div>}
    <div className="my-4 flex flex-wrap gap-2">
      {!content&&<Button disabled={disabled} onClick={()=>{const c=manualStory('Describe the story');setContent(c);setDirty(true);sessionStorage.setItem(`${slot}-draft`,JSON.stringify({...token,content:c}));}}>Start manual plan</Button>}
      <Button variant="outline" disabled={disabled||dirty} onClick={()=>void fixture()}>Load 45s fixture proposal</Button>
      <Button disabled={disabled||!dirty||!content} onClick={()=>{try{mutate('revisions',saveStorySchema.parse({...token,content}));}catch{setError('Check required fields and story limits before saving.');}}}>Save new revision</Button>
      <Button variant="outline" disabled={disabled||dirty||!board?.active} onClick={()=>void revalidate()}>Validate story</Button>
      {board?.active?.state==='DRAFT'&&<Button disabled={disabled||dirty} onClick={()=>mutate('mark-planned',token)}>Mark planned</Button>}
      {board?.active?.state==='PLANNED'&&<Button disabled={disabled||dirty} onClick={()=>mutate('submit-review',token)}>Submit for review</Button>}
      {board?.active?.state==='IN_REVIEW'&&<Button disabled={disabled||dirty} onClick={()=>{if(window.confirm(`Approve revision ${board.active!.revisionNo}? This approves story intent; video dispatch still requires its own gates.`))mutate('approve',token);}}>Approve story</Button>}
      <Button variant="outline" disabled={busy||Boolean(pending)} onClick={()=>{if(!dirty||window.confirm('Discard unsaved edits and reload current revision?')){sessionStorage.removeItem(`${slot}-draft`);void load().catch(()=>setError('Reload failed.'));}}}>Reload current revision</Button>
    </div>
    {proposal&&<p className="my-3 text-amber-300">FIXTURE proposal — The Last Light, 45s / 8 shots. No LIVE AI inference. Review before saving.</p>}
    {content&&<fieldset disabled={disabled} className="grid gap-6 xl:grid-cols-[220px_minmax(0,1fr)_minmax(280px,1fr)]">
      <legend className="sr-only">Storyboard editor</legend>
      <aside className="space-y-4 border-r border-zinc-800 pr-4"><h2 className="font-semibold">Scenes and shots</h2>
        {content.scenes.map((scene,si)=><section key={scene.clientRef} className="space-y-2"><Field label={`Scene ${si+1} title`} value={scene.title} onChange={v=>edit(c=>{c.scenes[si].title=v;})}/>
          {scene.shots.map((s,qi)=><button type="button" key={s.clientRef} aria-pressed={selected.scene===si&&selected.shot===qi} onClick={()=>setSelected({scene:si,shot:qi})} className={`block w-full text-left rounded px-2 py-2 text-sm ${selected.scene===si&&selected.shot===qi?'bg-zinc-800 text-amber-300':'text-zinc-400'}`}>Shot {qi+1} · {s.spec.durationSeconds}s</button>)}
          <Button variant="outline" onClick={()=>edit(c=>{const spec=structuredClone(c.scenes[si].shots[0]?.spec??manualStory('New shot').scenes[0].shots[0].spec);c.scenes[si].shots.push({clientRef:`shot-${crypto.randomUUID()}`,spec});})}>Add shot</Button>
          <Button variant="outline" disabled={content.scenes.length<2} onClick={()=>{edit(c=>{c.scenes.splice(si,1);});setSelected({scene:0,shot:0});}}>Remove scene</Button>
          <Button variant="outline" disabled={si===0} onClick={()=>{edit(c=>{[c.scenes[si-1],c.scenes[si]]=[c.scenes[si],c.scenes[si-1]];});setSelected({scene:0,shot:0});}}>Move scene up</Button>
          <Button variant="outline" disabled={si===content.scenes.length-1} onClick={()=>{edit(c=>{[c.scenes[si+1],c.scenes[si]]=[c.scenes[si],c.scenes[si+1]];});setSelected({scene:0,shot:0});}}>Move scene down</Button>
        </section>)}
        <Button variant="outline" onClick={()=>edit(c=>{const scene=manualStory('New shot').scenes[0];scene.shots[0].spec=structuredClone(c.scenes[0].shots[0]?.spec??scene.shots[0].spec);scene.clientRef=`scene-${crypto.randomUUID()}`;scene.shots[0].clientRef=`shot-${crypto.randomUUID()}`;c.scenes.push(scene);})}>Add scene</Button>
      </aside>
      <section aria-label="Script and Story Bible" className="space-y-6 min-w-0"><Field label="Script" value={content.script} onChange={v=>edit(c=>{c.script=v;})} multiline/>
        <h2 className="font-semibold">Story Bible</h2><Field label="Narrative and visual direction" value={content.storyBible.narrative} onChange={v=>edit(c=>{c.storyBible.narrative=v;})} multiline/>
        {(['characters','wardrobes','props','locations','styleRefs'] as const).map(group=><section key={group} className="space-y-3 border-t border-zinc-800 pt-3"><h3 className="text-sm font-semibold">{group}</h3>{content.storyBible[group].map((d,i)=><div key={d.id} className="space-y-2"><Field label={`${group} ${i+1} name (${d.id})`} value={d.name} onChange={v=>edit(c=>{c.storyBible[group][i].name=v;})}/><Field label={`${d.name} definition`} value={d.description} onChange={v=>edit(c=>{c.storyBible[group][i].description=v;})} multiline/>{group==='props'&&<label className="text-sm"><input type="checkbox" checked={content.storyBible.props[i].hero} onChange={e=>edit(c=>{c.storyBible.props[i].hero=e.target.checked;})}/> Hero / brand-critical prop</label>}</div>)}<Button variant="outline" onClick={()=>edit(c=>{const definition={id:`ref-${crypto.randomUUID()}`,name:'New definition',description:'Describe the identity'};if(group==='props')c.storyBible.props.push({...definition,hero:false});else c.storyBible[group].push(definition);})}>Add {group}</Button></section>)}
      </section>
      <aside className="space-y-4 min-w-0"><h2 className="font-semibold">Shot inspector</h2>{shot&&<>
        <Field label="Shot prompt" value={shot.spec.prompt} onChange={v=>updateShot(s=>{s.prompt=v;})} multiline/>
        <Field label="Negative prompt" value={shot.spec.negativePrompt} onChange={v=>updateShot(s=>{s.negativePrompt=v;})} multiline/>
        <label className="block text-sm">Duration seconds<input className={inputClass} type="number" min={1} max={60} value={shot.spec.durationSeconds} onChange={e=>updateShot(s=>{s.durationSeconds=Number(e.target.value);})}/></label>
        <label className="block text-sm">Shot type<select className={inputClass} value={shot.spec.shotType} onChange={e=>updateShot(s=>{s.shotType=e.target.value as ShotSpec['shotType'];})}>{['CHARACTER','ACTION','DIALOGUE','ESTABLISHING','BROLL','INSERT','PRODUCT','OTHER'].map(t=><option key={t}>{t}</option>)}</select></label>
        <Field label="Camera framing" value={shot.spec.camera.framing} onChange={v=>updateShot(s=>{s.camera.framing=v;})}/><Field label="Camera movement" value={shot.spec.camera.movement} onChange={v=>updateShot(s=>{s.camera.movement=v;})}/>
        {(['locationId','styleRefId'] as const).map(field=><label key={field} className="block text-sm">{field==='locationId'?'Shot location':'Visual style'}<select className={inputClass} value={shot.spec[field]} onChange={e=>updateShot(s=>{s[field]=e.target.value;if(field==='locationId'){s.continuity.start.locationId=e.target.value;s.continuity.end.locationId=e.target.value;}})}>{content.storyBible[field==='locationId'?'locations':'styleRefs'].map(d=><option value={d.id} key={d.id}>{d.name}</option>)}</select></label>)}
        <p className="text-sm text-zinc-400">Keyframe: {board?.revision?.shotRevisions[shot.id??'']?.policy.effectiveRequirement??'Classified on save'}</p>
        <label className="block text-sm"><input type="checkbox" checked={Boolean(shot.spec.keyframeOverride)} onChange={e=>updateShot(s=>{s.keyframeOverride=e.target.checked?{requirement:'REQUIRED',reason:'',riskAcknowledged:true}:null;})}/> Explicit keyframe policy override (acknowledge risk)</label>
        {shot.spec.keyframeOverride&&<><label className="block text-sm">Override requirement<select className={inputClass} value={shot.spec.keyframeOverride.requirement} onChange={e=>updateShot(s=>{if(s.keyframeOverride)s.keyframeOverride.requirement=e.target.value as 'REQUIRED'|'OPTIONAL';})}><option>REQUIRED</option><option>OPTIONAL</option></select></label><Field label="Override reason" value={shot.spec.keyframeOverride.reason} onChange={v=>updateShot(s=>{if(s.keyframeOverride)s.keyframeOverride.reason=v;})}/></>}
        <h3 className="font-semibold">Intentional transition from preceding shot</h3>
        {(['wardrobe','heldProps','pose','location','lighting','props'] as const).map(field=><div key={field}><label className="text-sm"><input type="checkbox" checked={shot.spec.intendedTransitions.some(t=>t.field===field)} onChange={e=>updateShot(s=>{s.intendedTransitions=e.target.checked?[...s.intendedTransitions,{field,reason:''}]:s.intendedTransitions.filter(t=>t.field!==field);})}/> Intentional {field} change</label>{shot.spec.intendedTransitions.find(t=>t.field===field)&&<Field label={`${field} transition reason`} value={shot.spec.intendedTransitions.find(t=>t.field===field)!.reason} onChange={v=>updateShot(s=>{s.intendedTransitions.find(t=>t.field===field)!.reason=v;})}/>}</div>)}
        {(['start','end'] as const).map(side=><section key={side} className="space-y-2 border-t border-zinc-800 pt-3"><h3 className="font-semibold">Continuity {side}</h3><Field label={`${side} lighting`} value={shot.spec.continuity[side].lighting} onChange={v=>updateShot(s=>{s.continuity[side].lighting=v;})}/><p className="text-sm text-zinc-400">Location: {content.storyBible.locations.find(d=>d.id===shot.spec.locationId)?.name??shot.spec.locationId}</p>
          {content.storyBible.props.map(p=><label className="block text-sm" key={p.id}><input type="checkbox" checked={shot.spec.continuity[side].propIds.includes(p.id)} onChange={e=>updateShot(s=>{s.continuity[side].propIds=e.target.checked?[...s.continuity[side].propIds,p.id]:s.continuity[side].propIds.filter(id=>id!==p.id);})}/> {side} prop: {p.name}</label>)}
          {shot.spec.continuity[side].characterStates.map((c,ci)=><div key={c.characterId} className="space-y-2"><p className="text-sm">{content.storyBible.characters.find(d=>d.id===c.characterId)?.name}</p><Field label={`${side} ${c.characterId} pose`} value={c.pose} onChange={v=>updateShot(s=>{s.continuity[side].characterStates[ci].pose=v;})}/><label className="block text-sm">{side} wardrobe<select className={inputClass} value={c.wardrobeId} onChange={e=>updateShot(s=>{s.continuity[side].characterStates[ci].wardrobeId=e.target.value;})}>{content.storyBible.wardrobes.map(w=><option key={w.id} value={w.id}>{w.name}</option>)}</select></label>{content.storyBible.props.map(p=><label className="block text-sm" key={p.id}><input type="checkbox" checked={c.heldPropIds.includes(p.id)} onChange={e=>updateShot(s=>{const v=s.continuity[side].characterStates[ci];v.heldPropIds=e.target.checked?[...v.heldPropIds,p.id]:v.heldPropIds.filter(id=>id!==p.id);})}/> {side} held: {p.name}</label>)}</div>)}
        </section>)}
        <h3 className="font-semibold">On-screen characters</h3>{content.storyBible.characters.map(character=><label className="block text-sm" key={character.id}><input type="checkbox" checked={shot.spec.subjectIds.includes(character.id)} onChange={e=>updateShot(s=>{
          if(e.target.checked){const wardrobe=content.storyBible.wardrobes[0];if(!wardrobe){setError('Add a wardrobe before assigning a character.');return;}s.subjectIds.push(character.id);for(const side of ['start','end'] as const)if(!s.continuity[side].characterStates.some(c=>c.characterId===character.id))s.continuity[side].characterStates.push({characterId:character.id,wardrobeId:wardrobe.id,pose:'Standing',heldPropIds:[]});}
          else{s.subjectIds=s.subjectIds.filter(id=>id!==character.id);for(const side of ['start','end'] as const)s.continuity[side].characterStates=s.continuity[side].characterStates.filter(c=>c.characterId!==character.id);}
        })}/> {character.name}</label>)}
        <div className="flex gap-2 flex-wrap">
          <Button variant="outline" disabled={selected.shot===0} onClick={()=>{edit(c=>{const a=c.scenes[selected.scene].shots;[a[selected.shot-1],a[selected.shot]]=[a[selected.shot],a[selected.shot-1]];});setSelected(s=>({...s,shot:s.shot-1}));}}>Move shot up</Button>
          <Button variant="outline" disabled={selected.shot===content.scenes[selected.scene].shots.length-1} onClick={()=>{edit(c=>{const a=c.scenes[selected.scene].shots;[a[selected.shot+1],a[selected.shot]]=[a[selected.shot],a[selected.shot+1]];});setSelected(s=>({...s,shot:s.shot+1}));}}>Move shot down</Button>
          <Button variant="outline" onClick={()=>edit(c=>{c.scenes[selected.scene].shots.splice(selected.shot+1,0,{clientRef:`shot-${crypto.randomUUID()}`,spec:structuredClone(shot.spec)});})}>Duplicate shot</Button>
          <Button variant="outline" disabled={content.scenes[selected.scene].shots.length<2} onClick={()=>{edit(c=>{c.scenes[selected.scene].shots.splice(selected.shot,1);});setSelected(s=>({...s,shot:0}));}}>Remove shot</Button>
        </div>
        {content.scenes.length>1&&<label className="block text-sm">Move to scene<select className={inputClass} value={selected.scene} onChange={e=>{const target=Number(e.target.value);edit(c=>{const [moved]=c.scenes[selected.scene].shots.splice(selected.shot,1);c.scenes[target].shots.push(moved);});setSelected({scene:target,shot:content.scenes[target].shots.length});}}>{content.scenes.map((s,i)=><option key={s.clientRef} value={i}>{s.title}</option>)}</select></label>}
      </>}</aside>
    </fieldset>}
    <section className="mt-8 border-t border-zinc-800 py-5"><h2 className="font-semibold mb-3">Validation and approval evidence</h2>{historicalValidation&&<p role="status" className="text-amber-300">Historical evidence uses {board?.validation?.ruleSetVersion}; current G1 requires {board?.currentRuleSetVersion}. Create and approve a successor revision for current acceptance.</p>}{board?.validation?.findings.length===0&&!historicalValidation&&<p>No blocking findings under {board.currentRuleSetVersion}.</p>}{board?.validation?.findings.map(f=><div key={f.fingerprint} className="my-3 text-sm"><p className={f.severity==='ERROR'?'text-rose-300':'text-amber-300'}>{f.severity}: {f.message}</p><p className="text-zinc-500">{f.path}</p>{board.waivers.some(w=>w.findingFingerprint===f.fingerprint)?<p>Waived with producer reason.</p>:f.waivable&&<Button variant="outline" disabled={disabled||dirty||!['PLANNED','IN_REVIEW'].includes(board.active?.state??'')} onClick={()=>{const reason=window.prompt('Reason for accepting this wardrobe/held-prop mismatch');if(reason?.trim())mutate('waivers',{...token,findingFingerprint:f.fingerprint,reason});}}>Waive finding</Button>}</div>)}{board?.approval&&<p className={historicalValidation?'text-amber-300':'text-emerald-300'}>Approval recorded for revision {board.revision?.revisionNo}. {historicalValidation?'This remains historical audit evidence only.':'Evidence is bound to this content, waiver set, and current ruleset.'}</p>}</section>
    <section className="border-t border-zinc-800 py-5"><h2 className="font-semibold mb-3">Revision history</h2><div className="flex gap-2 flex-wrap">{board?.history.map(r=><Button key={r.id} variant="outline" disabled={busy||dirty||Boolean(pending)} onClick={()=>void load(r.id).catch(()=>setError('Unable to read history.'))}>Revision {r.revisionNo} · {r.state}</Button>)}</div></section>
  </div>;
}
