'use client';
import { useEffect, useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  cameraAngleSchema,
  createShotSpecV2,
  expectedSchema,
  filmDtoSchema,
  formatMicros,
  saveStorySchema,
  storyContentSchema,
  upgradeBibleToV2,
  type BibleGroup,
  type CameraAngle,
  type Expected,
  type GenerationPreviewResponse,
  type ReferenceAssetDto,
  type ShotSpec,
  type Storyboard,
  type StoryContent,
} from '@nolen/contracts';
import { Button } from './ui/button';
import { Navigation } from './navigation';
import { KeyframeReviewModal } from './keyframe-review';
import { VideoReviewModal } from './video-review';
import { errorMessage } from '../lib/api';

const CAMERA_ANGLES = cameraAngleSchema.options;

type Pending={key:string;route:string;body:unknown};
type PendingAttempt={
  key: string;
  shotId: string;
  shotRevisionId: string;
  storyRevisionId: string;
  kind: 'IMAGE' | 'VIDEO';
  provider: string;
  rateCardSnapshotId: string;
  pricingUnits: number;
  executionMode: 'REPLAY' | 'LIVE';
  expectedPreviewHash: string;
  createdAt: number;
};
const routes=['revisions','mark-planned','submit-review','approve','waivers'];
const inputClass='w-full rounded border border-zinc-700 bg-zinc-950 p-2 text-sm text-zinc-100';
/** Small labeled editor reused for creative prose; no implementation fields exposed. */
function Field({label,value,onChange,multiline=false}:{label:string;value:string;onChange:(value:string)=>void;multiline?:boolean}){
  const id=useId();
  return <div className="text-xs text-zinc-400 space-y-1"><label htmlFor={id}>{label}</label>{multiline?<textarea id={id} className={inputClass} rows={3} value={value} onChange={e=>onChange(e.target.value)}/>:<input id={id} className={inputClass} value={value} onChange={e=>onChange(e.target.value)}/>}</div>;
}
/** Initial manual intent is visibly editable as StoryBible v2 + ShotSpec v2 with explicit EYE_LEVEL angle. */
function manualStory(brief:string):StoryContent {
  const state={locationId:'location',lighting:'Daylight',propIds:[],characterStates:[]};
  return storyContentSchema.parse({
    script:brief,
    storyBible:{
      schemaVersion:'2',
      narrative:'Describe the visual direction',
      characters:[],
      wardrobes:[],
      props:[],
      locations:[{id:'location',name:'Location',description:'Describe the location',referenceAssetIds:[]}],
      styleRefs:[{id:'style',name:'Style',description:'Describe the visual style',referenceAssetIds:[]}],
    },
    scenes:[{
      clientRef:'scene-1',
      title:'Scene 1',
      shots:[{
        clientRef:'shot-1',
        spec:createShotSpecV2({
          shotType:'ESTABLISHING',
          durationSeconds:30,
          prompt:brief,
          camera:{angle:'EYE_LEVEL',framing:'Wide',movement:'Static'},
          styleRefId:'style',
          subjectIds:[],
          locationId:'location',
          continuity:{start:state,end:state},
        }),
      }],
    }],
  });
}
/** Restore only recognized command routes and request identities from tab-local storage. */
function pendingFrom(raw:string):Pending {
  const p:unknown=JSON.parse(raw);
  if(!p||typeof p!=='object'||!('route'in p)||typeof p.route!=='string'||!routes.includes(p.route)||!('key'in p)||typeof p.key!=='string'||!/^[\da-f-]{36}$/i.test(p.key)||!('body'in p))throw new Error('Unreadable pending command');
  return {route:p.route,key:p.key,body:p.body};
}
/** Three-pane G1 editor; uncertain commands retain exact payload/key until a definite response. */
export function StoryboardWorkspace({filmId}:{filmId:string}){
  const router=useRouter();const base=`/api/films/${filmId}`;const slot=`nolen-story-${filmId}`;const attemptSlot=`nolen-attempt-${filmId}`;
  const [board,setBoard]=useState<Storyboard|null>(null);const [content,setContent]=useState<StoryContent|null>(null);
  const [token,setToken]=useState<Expected>({expectedStoryRevisionId:null,expectedStateVersion:0});
  const [budget,setBudget]=useState('');const [error,setError]=useState('');const [busy,setBusy]=useState(false);const [dirty,setDirty]=useState(false);
  const [pending,setPending]=useState<Pending|null>(null);const [pendingAttempt,setPendingAttempt]=useState<PendingAttempt|null>(null);
  const [storageBlocked,setStorageBlocked]=useState(false);const [historical,setHistorical]=useState(false);
  const [selected,setSelected]=useState({scene:0,shot:0});const [proposal,setProposal]=useState(false);
  const [keyframeModalOpen,setKeyframeModalOpen]=useState(false);
  const [videoModalOpen,setVideoModalOpen]=useState(false);
  const [rateCards,setRateCards]=useState<{id:string;provider:string;model:string;operation:string;rateType:string;unitPriceUsdMicros:string}[]>([]);
  const [generatingKind,setGeneratingKind]=useState<'IMAGE'|'VIDEO'|null>(null);
  const [generatingProgress,setGeneratingProgress]=useState<string|null>(null);
  const [generationError,setGenerationError]=useState<string|null>(null);
  const [executionMode,setExecutionMode]=useState<'REPLAY'|'LIVE'>('REPLAY');
  const [selectedVideoProvider,setSelectedVideoProvider]=useState<'RUNWAY'|'FAL_KLING'|'LOCAL_PAN_ZOOM'>('RUNWAY');
  const [shotMediaMap,setShotMediaMap]=useState<Record<string,{keyframeApproved:boolean;keyframePending:boolean;videoApproved:boolean;videoPending:boolean;attemptsCount:number}>>({});
  const [referenceAssets,setReferenceAssets]=useState<ReferenceAssetDto[]>([]);
  const [refLabel,setRefLabel]=useState('');
  const [refSourceNote,setRefSourceNote]=useState('');
  const [refLicenseUrl,setRefLicenseUrl]=useState('');
  const [refRightsConfirmed,setRefRightsConfirmed]=useState(false);
  const [refFile,setRefFile]=useState<File|null>(null);
  const [refUploading,setRefUploading]=useState(false);
  const [refError,setRefError]=useState<string|null>(null);
  const [bindSelections,setBindSelections]=useState<Record<string,string>>({});
  const [addShotPrompt,setAddShotPrompt]=useState<{sceneIndex:number;angle:CameraAngle}|null>(null);
  const [duplicateV1Angle,setDuplicateV1Angle]=useState<CameraAngle|null>(null);
  const [imagePreview,setImagePreview]=useState<GenerationPreviewResponse|null>(null);
  const [videoPreview,setVideoPreview]=useState<GenerationPreviewResponse|null>(null);
  const [previewError,setPreviewError]=useState<string|null>(null);
  const [previewLoadingKind,setPreviewLoadingKind]=useState<'IMAGE'|'VIDEO'|null>(null);

  async function refreshReferenceAssets() {
    try {
      const res = await fetch(`${base}/reference-assets`, { cache: 'no-store' });
      if (res.ok) {
        setReferenceAssets((await res.json()) as ReferenceAssetDto[]);
      }
    } catch {
      // Non-blocking
    }
  }

  async function refreshShotMedia(shots: { id?: string }[]) {
    const validShots = shots.filter(s => Boolean(s.id));
    if (validShots.length === 0) return;
    const map: Record<string, { keyframeApproved: boolean; keyframePending: boolean; videoApproved: boolean; videoPending: boolean; attemptsCount: number }> = {};

    await Promise.all(
      validShots.map(async s => {
        try {
          const [assetsRes, attemptsRes] = await Promise.all([
            fetch(`${base}/shots/${s.id}/assets`, { cache: 'no-store' }),
            fetch(`${base}/shots/${s.id}/attempts`, { cache: 'no-store' }),
          ]);
          let keyframeApproved = false;
          let keyframePending = false;
          let videoApproved = false;
          let videoPending = false;
          let attemptsCount = 0;

          if (assetsRes.ok) {
            const assets = (await assetsRes.json()) as { kind: string; latestReviewDecision: string | null; isSelected: boolean }[];
            keyframeApproved = assets.some(a => a.kind === 'IMAGE' && a.latestReviewDecision === 'APPROVED' && a.isSelected);
            keyframePending = !keyframeApproved && assets.some(a => a.kind === 'IMAGE' && (!a.latestReviewDecision || a.latestReviewDecision === 'PENDING_REVIEW'));
            videoApproved = assets.some(a => a.kind === 'VIDEO' && a.latestReviewDecision === 'APPROVED' && a.isSelected);
            videoPending = !videoApproved && assets.some(a => a.kind === 'VIDEO' && (!a.latestReviewDecision || a.latestReviewDecision === 'PENDING_REVIEW'));
          }
          if (attemptsRes.ok) {
            const attempts = (await attemptsRes.json()) as unknown[];
            attemptsCount = attempts.length;
          }
          map[s.id!] = { keyframeApproved, keyframePending, videoApproved, videoPending, attemptsCount };
        } catch {
          // Non-blocking for badge display
        }
      })
    );
    setShotMediaMap(prev => ({ ...prev, ...map }));
  }

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
    if(next) {
      const allShots = next.scenes.flatMap(s => s.shots);
      void refreshShotMedia(allShots);
    }
    void refreshReferenceAssets();
  }
  useEffect(()=>{void(async()=>{
    try{
      const raw=sessionStorage.getItem(`${slot}-pending`);if(raw)setPending(pendingFrom(raw));
      const rawAttempt=sessionStorage.getItem(attemptSlot);
      if(rawAttempt){
        try{
          const parsed=JSON.parse(rawAttempt) as PendingAttempt;
          if(parsed&&typeof parsed.key==='string'&&parsed.shotId&&parsed.kind&&typeof parsed.expectedPreviewHash==='string')setPendingAttempt(parsed);
        }catch{}
      }
      await load(undefined,true);
      const response=await fetch(base,{cache:'no-store'});if(response.ok)setBudget(filmDtoSchema.parse(await response.json()).budgetLimitUsdMicros);
      const rcRes = await fetch('/api/rate-cards', { cache: 'no-store' });
      if (rcRes.ok) setRateCards(await rcRes.json());
    }catch{setStorageBlocked(true);setError('Unable to restore the workspace. Reload or explicitly discard stored state.');}
  })();},[filmId,attemptSlot]);

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

  async function fetchPreview(kind: 'IMAGE' | 'VIDEO'): Promise<GenerationPreviewResponse | null> {
    if (!shot?.id || !board?.revision || !board.active || board.active.state !== 'APPROVED') return null;
    const sRev = board.revision.shotRevisions[shot.id];
    if (!sRev) return null;

    const targetProvider = kind === 'IMAGE' ? 'GEMINI' : selectedVideoProvider;
    const targetCard = rateCards.find(rc => rc.operation === kind && rc.provider === targetProvider);
    if (!targetCard) return null;

    setPreviewLoadingKind(kind);
    setPreviewError(null);
    try {
      const res = await fetch(`${base}/generation-previews`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          storyRevisionId: board.active.id,
          shotRevisionId: sRev.id,
          kind,
          rateCardSnapshotId: targetCard.id,
          pricingUnits: kind === 'VIDEO' ? Math.max(1, shot.spec.durationSeconds) : 1,
          executionMode,
        }),
      });
      if (!res.ok) {
        const msg = await errorMessage(res);
        setPreviewError(msg);
        if (kind === 'IMAGE') setImagePreview(null);
        else setVideoPreview(null);
        return null;
      }
      const data = (await res.json()) as GenerationPreviewResponse;
      if (kind === 'IMAGE') setImagePreview(data);
      else setVideoPreview(data);
      return data;
    } catch {
      setPreviewError('Failed to fetch server generation preview.');
      return null;
    } finally {
      setPreviewLoadingKind(null);
    }
  }

  const activeShotIdForEffect = shot?.id;
  const activeShotRevIdForEffect = activeShotIdForEffect && board?.revision ? board.revision.shotRevisions[activeShotIdForEffect]?.id : undefined;
  const activeStoryIdForEffect = board?.active?.id;
  const activeStoryStateForEffect = board?.active?.state;
  const activeShotMedia = activeShotIdForEffect ? shotMediaMap[activeShotIdForEffect] : undefined;
  const activeKeyframeApproved = Boolean(activeShotMedia?.keyframeApproved);
  const hasImageCard = rateCards.some(rc => rc.operation === 'IMAGE' && rc.provider === 'GEMINI');
  const hasVideoCard = rateCards.some(rc => rc.operation === 'VIDEO' && rc.provider === selectedVideoProvider);

  useEffect(() => {
    setImagePreview(null);
    setVideoPreview(null);
    setPreviewError(null);
    if (activeStoryStateForEffect !== 'APPROVED' || !activeStoryIdForEffect || !activeShotRevIdForEffect || historical) return;
    if (hasImageCard) void fetchPreview('IMAGE');
    if (hasVideoCard && activeKeyframeApproved) void fetchPreview('VIDEO');
  }, [activeStoryIdForEffect, activeStoryStateForEffect, activeShotRevIdForEffect, executionMode, selectedVideoProvider, activeKeyframeApproved, hasImageCard, hasVideoCard, historical]);

  async function handleReferenceUpload(e: React.FormEvent) {
    e.preventDefault();
    if (!refFile) {
      setRefError('Select a PNG, JPEG, or WebP file.');
      return;
    }
    setRefUploading(true);
    setRefError(null);
    try {
      const form = new FormData();
      form.set('file', refFile);
      form.set('label', refLabel.trim());
      form.set('sourceNote', refSourceNote.trim());
      if (refLicenseUrl.trim()) form.set('licenseUrl', refLicenseUrl.trim());
      form.set('rightsConfirmed', refRightsConfirmed ? 'true' : 'false');

      const res = await fetch(`${base}/reference-assets`, {
        method: 'POST',
        body: form,
      });
      if (!res.ok) throw new Error(await errorMessage(res));
      setRefLabel('');
      setRefSourceNote('');
      setRefLicenseUrl('');
      setRefRightsConfirmed(false);
      setRefFile(null);
      await refreshReferenceAssets();
    } catch (err: unknown) {
      setRefError(err instanceof Error ? err.message : 'Reference upload failed');
    } finally {
      setRefUploading(false);
    }
  }

  function handleBindReference(group: BibleGroup, defId: string) {
    if (!content) return;
    const selectedAssetId = bindSelections[`${group}:${defId}`] ?? referenceAssets[0]?.id;
    if (!selectedAssetId) {
      setError('Upload a reference image before binding.');
      return;
    }
    if (content.storyBible.schemaVersion === '1') {
      const confirmed = window.confirm(
        'Binding a reference asset will upgrade the Story Bible to v2, create a new DRAFT StoryRevision, and require re-approval (existing selection badges will reset). Continue?',
      );
      if (!confirmed) return;
      edit(c => {
        c.storyBible = upgradeBibleToV2(c.storyBible, { group, id: defId, assetId: selectedAssetId });
      });
      return;
    }
    edit(c => {
      if (c.storyBible.schemaVersion !== '2') return;
      const item = c.storyBible[group].find(x => x.id === defId);
      if (item && !item.referenceAssetIds.includes(selectedAssetId)) {
        item.referenceAssetIds.push(selectedAssetId);
      }
    });
  }

  async function handleGenerate(kind: 'IMAGE' | 'VIDEO', retryPending?: PendingAttempt) {
    if (!shot?.id || !board?.revision || !board.active) return;
    const shotRev = board.revision.shotRevisions[shot.id];
    if (!shotRev) return;

    const currentMedia = shotMediaMap[shot.id] ?? { keyframeApproved: false, videoApproved: false, keyframePending: false, videoPending: false, attemptsCount: 0 };
    if (kind === 'VIDEO' && !currentMedia.keyframeApproved) {
      setGenerationError('All available video providers (Runway I2V, fal Kling I2V, Local Pan/Zoom) require an approved reference keyframe before video generation.');
      return;
    }

    setGeneratingKind(kind);
    setGeneratingProgress('QUEUED');
    setGenerationError(null);

    let activePending = retryPending;
    if (!activePending && pendingAttempt && pendingAttempt.shotId === shot.id && pendingAttempt.kind === kind) {
      activePending = pendingAttempt;
    }

    // Fail closed: if an unresolved pending attempt exists on another shot or kind,
    // prevent fresh generation to avoid overwriting stored retry identity and causing duplicate charges.
    if (!activePending && pendingAttempt) {
      setGeneratingKind(null);
      setGeneratingProgress(null);
      setGenerationError(
        `Cannot start generation: an unresolved attempt is pending on shot "${pendingAttempt.shotId}" (${pendingAttempt.kind}). Resolve or discard it before creating new attempts.`
      );
      return;
    }

    let record: PendingAttempt;
    if (activePending) {
      // RETRY: Send every field verbatim from the stored pending attempt (including expectedPreviewHash)
      record = activePending;
    } else {
      // FRESH ATTEMPT: Use authoritative server preview hash
      const targetProvider = kind === 'IMAGE' ? 'GEMINI' : selectedVideoProvider;
      const targetCard = rateCards.find(rc => rc.operation === kind && rc.provider === targetProvider);
      if (!targetCard) {
        setGeneratingKind(null);
        setGeneratingProgress(null);
        setGenerationError(`No active rate card found for provider ${targetProvider} (${kind}). Generation aborted.`);
        return;
      }

      const activePreview = kind === 'IMAGE' ? imagePreview : videoPreview;
      const resolvedPreview =
        activePreview &&
        activePreview.template.shotRevisionId === shotRev.id &&
        activePreview.template.rateCardSnapshotId === targetCard.id &&
        activePreview.template.executionMode === executionMode
          ? activePreview
          : await fetchPreview(kind);

      if (!resolvedPreview) {
        setGeneratingKind(null);
        setGeneratingProgress(null);
        setGenerationError('Authoritative server preview is required before generating.');
        return;
      }

      record = {
        key: crypto.randomUUID(),
        shotId: shot.id,
        shotRevisionId: shotRev.id,
        storyRevisionId: board.active.id,
        kind,
        provider: targetProvider,
        rateCardSnapshotId: targetCard.id,
        pricingUnits: kind === 'VIDEO' ? Math.max(1, shot.spec.durationSeconds) : 1,
        executionMode,
        expectedPreviewHash: resolvedPreview.previewHash,
        createdAt: Date.now(),
      };

      // Persist to session storage BEFORE dispatch. If storage fails, abort to prevent untracked dispatch
      try {
        sessionStorage.setItem(attemptSlot, JSON.stringify(record));
        setPendingAttempt(record);
      } catch {
        setStorageBlocked(true);
        setGeneratingKind(null);
        setGeneratingProgress(null);
        setGenerationError('Tab storage is unavailable. Cannot safely dispatch billable attempt without guaranteed retry identity.');
        return;
      }
    }

    try {
      const res = await fetch(`${base}/attempts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': record.key,
        },
        body: JSON.stringify({
          storyRevisionId: record.storyRevisionId,
          shotRevisionId: record.shotRevisionId,
          kind: record.kind,
          rateCardSnapshotId: record.rateCardSnapshotId,
          pricingUnits: record.pricingUnits,
          executionMode: record.executionMode,
          expectedPreviewHash: record.expectedPreviewHash,
        }),
      });

      if (res.status === 409) {
        const cloned = res.clone();
        const errBody = await cloned.json().catch(() => null) as { error?: { code?: string } } | null;
        if (errBody?.error?.code === 'GENERATION_PREVIEW_STALE') {
          try { sessionStorage.removeItem(attemptSlot); } catch {}
          setPendingAttempt(null);
          if (kind === 'IMAGE') setImagePreview(null);
          else setVideoPreview(null);
          void load();
        }
      }

      if (!res.ok) throw new Error(await errorMessage(res));
      const receipt = (await res.json()) as { attemptId: string };
      const attemptId = receipt.attemptId;

      try {
        sessionStorage.removeItem(attemptSlot);
        setPendingAttempt(null);
      } catch {
        // Ignore
      }

      // Short-poll status
      let finalState = 'QUEUED';
      for (let i = 0; i < 40; i++) {
        await new Promise(r => setTimeout(r, 1500));
        const pollRes = await fetch(`/api/attempts/${attemptId}/financials`, { cache: 'no-store' });
        if (pollRes.ok) {
          const pollData = (await pollRes.json()) as { state: string };
          finalState = pollData.state;
          setGeneratingProgress(finalState);
          if (finalState === 'SUCCEEDED' || finalState === 'FAILED' || finalState === 'CANCELED') break;
        }
      }

      if (finalState === 'SUCCEEDED') {
        if (content) void refreshShotMedia(content.scenes.flatMap(s => s.shots));
        if (kind === 'IMAGE') setKeyframeModalOpen(true);
        else setVideoModalOpen(true);
      } else if (finalState === 'FAILED') {
        throw new Error('Generation failed in background worker.');
      } else {
        throw new Error('Generation timed out. Check review modal later.');
      }
    } catch (err: unknown) {
      setGenerationError(err instanceof Error ? err.message : 'Generation failed');
    } finally {
      setGeneratingKind(null);
      setGeneratingProgress(null);
    }
  }

  const currentMedia = shot?.id ? shotMediaMap[shot.id] ?? { keyframeApproved: false, videoApproved: false, keyframePending: false, videoPending: false, attemptsCount: 0 } : { keyframeApproved: false, videoApproved: false, keyframePending: false, videoPending: false, attemptsCount: 0 };
  const shotRev = shot?.id && board?.revision ? board.revision.shotRevisions[shot.id] : null;
  const isStoryApproved = board?.active?.state === 'APPROVED';
  const isKeyframeRequired = shotRev?.policy.effectiveRequirement === 'REQUIRED';
  // Provider-gated: all current video engines (Runway I2V, fal Kling I2V, Local Pan/Zoom) require an approved keyframe
  const isVideoBlockedByKeyframe = !currentMedia.keyframeApproved;
  const activeVideoRateCard = rateCards.find(rc => rc.operation === 'VIDEO' && rc.provider === selectedVideoProvider);
  const activeImageRateCard = rateCards.find(rc => rc.operation === 'IMAGE' && rc.provider === 'GEMINI');

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
          {scene.shots.map((s,qi)=>{
            const m = s.id ? shotMediaMap[s.id] : undefined;
            return (
              <button
                type="button"
                key={s.clientRef}
                aria-pressed={selected.scene===si&&selected.shot===qi}
                onClick={()=>setSelected({scene:si,shot:qi})}
                className={`flex items-center justify-between w-full text-left rounded px-2 py-2 text-sm ${
                  selected.scene===si&&selected.shot===qi?'bg-zinc-800 text-amber-300':'text-zinc-400'
                }`}
              >
                <span>Shot {qi+1} · {s.spec.durationSeconds}s</span>
                <span className="flex items-center gap-1 text-[10px] font-mono">
                  {m?.keyframeApproved ? (
                    <span className="bg-emerald-950/80 text-emerald-400 px-1 py-0.5 rounded border border-emerald-800/60" title="Keyframe approved">KF✓</span>
                  ) : m?.keyframePending ? (
                    <span className="bg-amber-950/80 text-amber-400 px-1 py-0.5 rounded border border-amber-800/60" title="Keyframe pending review">KF?</span>
                  ) : null}
                  {m?.videoApproved ? (
                    <span className="bg-emerald-950/80 text-emerald-400 px-1 py-0.5 rounded border border-emerald-800/60" title="Video approved">VID✓</span>
                  ) : m?.videoPending ? (
                    <span className="bg-amber-950/80 text-amber-400 px-1 py-0.5 rounded border border-amber-800/60" title="Video pending review">VID?</span>
                  ) : null}
                </span>
              </button>
            );
          })}
          <Button variant="outline" onClick={()=>setAddShotPrompt({sceneIndex:si,angle:'EYE_LEVEL'})}>Add shot</Button>
          {addShotPrompt && addShotPrompt.sceneIndex === si && (
            <div className="space-y-2 rounded border border-amber-700/60 bg-zinc-900/70 p-2 text-xs">
              <label className="block">
                New shot camera angle
                <select
                  className={inputClass}
                  value={addShotPrompt.angle}
                  onChange={e=>setAddShotPrompt({...addShotPrompt,angle:e.target.value as CameraAngle})}
                >
                  {CAMERA_ANGLES.map(a=><option key={a} value={a}>{a}</option>)}
                </select>
              </label>
              <div className="flex gap-2">
                <Button
                  type="button"
                  onClick={()=>{
                    edit(draft=>{
                      const baseSpec=structuredClone(draft.scenes[si].shots[0]?.spec??manualStory('New shot').scenes[0].shots[0].spec);
                      const nextSpec=createShotSpecV2({...baseSpec,camera:{angle:addShotPrompt.angle,framing:baseSpec.camera.framing,movement:baseSpec.camera.movement}});
                      draft.scenes[si].shots.push({clientRef:`shot-${crypto.randomUUID()}`,spec:nextSpec});
                    });
                    setAddShotPrompt(null);
                  }}
                >
                  Confirm add shot
                </Button>
                <Button type="button" variant="outline" onClick={()=>setAddShotPrompt(null)}>Cancel</Button>
              </div>
            </div>
          )}
          <Button variant="outline" disabled={content.scenes.length<2} onClick={()=>{edit(c=>{c.scenes.splice(si,1);});setSelected({scene:0,shot:0});}}>Remove scene</Button>
          <Button variant="outline" disabled={si===0} onClick={()=>{edit(c=>{[c.scenes[si-1],c.scenes[si]]=[c.scenes[si],c.scenes[si-1]];});setSelected({scene:0,shot:0});}}>Move scene up</Button>
          <Button variant="outline" disabled={si===content.scenes.length-1} onClick={()=>{edit(c=>{[c.scenes[si+1],c.scenes[si]]=[c.scenes[si],c.scenes[si+1]];});setSelected({scene:0,shot:0});}}>Move scene down</Button>
        </section>)}
        <Button variant="outline" onClick={()=>edit(c=>{const scene=manualStory('New shot').scenes[0];scene.shots[0].spec=structuredClone(c.scenes[0].shots[0]?.spec??scene.shots[0].spec);scene.clientRef=`scene-${crypto.randomUUID()}`;scene.shots[0].clientRef=`shot-${crypto.randomUUID()}`;c.scenes.push(scene);})}>Add scene</Button>
      </aside>
      <section aria-label="Script and Story Bible" className="space-y-6 min-w-0"><Field label="Script" value={content.script} onChange={v=>edit(c=>{c.script=v;})} multiline/>
        <h2 className="font-semibold">Story Bible ({content.storyBible.schemaVersion === '2' ? 'v2' : 'v1'})</h2>
        <Field label="Narrative and visual direction" value={content.storyBible.narrative} onChange={v=>edit(c=>{c.storyBible.narrative=v;})} multiline/>
        <section aria-label="Reference Library" className="space-y-3 rounded border border-zinc-800 bg-zinc-900/40 p-3">
          <h3 className="text-sm font-semibold">Reference Library</h3>
          <div className="space-y-2 text-xs">
            <label className="block text-zinc-400">
              Reference image (PNG/JPEG/WebP, 300–4096px)
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={e=>setRefFile(e.target.files?.[0]??null)}
                className="mt-1 block w-full text-xs text-zinc-300"
              />
            </label>
            <Field label="Reference label" value={refLabel} onChange={setRefLabel}/>
            <Field label="Source note" value={refSourceNote} onChange={setRefSourceNote}/>
            <Field label="License URL (optional)" value={refLicenseUrl} onChange={setRefLicenseUrl}/>
            <label className="flex items-center gap-2 text-zinc-300">
              <input type="checkbox" checked={refRightsConfirmed} onChange={e=>setRefRightsConfirmed(e.target.checked)}/>
              <span>I confirm commercial/reference usage rights</span>
            </label>
            {refError && <p role="alert" className="text-rose-300">{refError}</p>}
            <Button type="button" variant="outline" disabled={refUploading} onClick={e=>void handleReferenceUpload(e)}>
              {refUploading ? 'Uploading…' : 'Upload reference'}
            </Button>
          </div>
          {referenceAssets.length > 0 && (
            <div className="grid gap-2 sm:grid-cols-2 pt-2 border-t border-zinc-800">
              {referenceAssets.map(ra=>(
                <div key={ra.id} className="flex gap-2 rounded border border-zinc-800 bg-zinc-950/70 p-2 text-xs">
                  <img src={ra.mediaUrl} alt={ra.label} className="h-14 w-14 rounded object-cover border border-zinc-800 shrink-0"/>
                  <div className="min-w-0 space-y-0.5">
                    <p className="font-medium text-zinc-200 truncate">{ra.label}</p>
                    <p className="text-[10px] font-mono text-zinc-400">{ra.width}×{ra.height} · {ra.mimeType}</p>
                    <p className="text-[10px] text-zinc-400 truncate">Source: {ra.sourceNote}</p>
                    <p className="text-[10px] text-emerald-400">Rights: {ra.rightsConfirmedBy}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
        {(['characters','wardrobes','props','locations','styleRefs'] as const).map(group=><section key={group} className="space-y-3 border-t border-zinc-800 pt-3"><h3 className="text-sm font-semibold">{group}</h3>{content.storyBible[group].map((d,i)=>{
          const boundIds = 'referenceAssetIds' in d ? d.referenceAssetIds : [];
          const bindKey = `${group}:${d.id}`;
          return <div key={d.id} className="space-y-2"><Field label={`${group} ${i+1} name (${d.id})`} value={d.name} onChange={v=>edit(c=>{c.storyBible[group][i].name=v;})}/><Field label={`${d.name} definition`} value={d.description} onChange={v=>edit(c=>{c.storyBible[group][i].description=v;})} multiline/>{group==='props'&&<label className="text-sm"><input type="checkbox" checked={content.storyBible.props[i].hero} onChange={e=>edit(c=>{content.storyBible.props[i].hero=e.target.checked;})}/> Hero / brand-critical prop</label>}
            <div className="space-y-1 rounded border border-zinc-800/70 bg-zinc-950/50 p-2 text-xs">
              <p className="text-zinc-400">Bound references ({boundIds.length})</p>
              {boundIds.map(refId=>{
                const meta = referenceAssets.find(r=>r.id===refId);
                return <div key={refId} className="flex items-center justify-between gap-2">
                  <span className="truncate text-zinc-300">{meta ? `${meta.label} (${meta.width}×${meta.height})` : refId}</span>
                  <Button type="button" variant="outline" className="h-6 px-2 text-[10px]" onClick={()=>edit(c=>{if(c.storyBible.schemaVersion==='2'){const item=c.storyBible[group][i] as {referenceAssetIds:string[]};item.referenceAssetIds=item.referenceAssetIds.filter(x=>x!==refId);}})}>Unbind</Button>
                </div>;
              })}
              {referenceAssets.length > 0 && (
                <div className="flex gap-2 pt-1">
                  <select
                    aria-label={`Select reference for ${d.name}`}
                    className={`${inputClass} h-7 py-0 text-xs`}
                    value={bindSelections[bindKey] ?? referenceAssets[0].id}
                    onChange={e=>setBindSelections(prev=>({...prev,[bindKey]:e.target.value}))}
                  >
                    {referenceAssets.map(ra=><option key={ra.id} value={ra.id}>{ra.label} ({ra.width}×{ra.height})</option>)}
                  </select>
                  <Button type="button" variant="outline" className="h-7 px-2 text-xs shrink-0" onClick={()=>handleBindReference(group, d.id)}>Bind reference</Button>
                </div>
              )}
            </div>
          </div>;
        })}<Button variant="outline" onClick={()=>edit(c=>{
          const id = `ref-${crypto.randomUUID()}`;
          if (c.storyBible.schemaVersion === '2') {
            const baseDef = { id, name: 'New definition', description: 'Describe the identity', referenceAssetIds: [] as string[] };
            if (group === 'props') c.storyBible.props.push({ ...baseDef, hero: false });
            else c.storyBible[group].push(baseDef);
          } else {
            const baseDef = { id, name: 'New definition', description: 'Describe the identity' };
            if (group === 'props') c.storyBible.props.push({ ...baseDef, hero: false });
            else c.storyBible[group].push(baseDef);
          }
        })}>Add {group}</Button></section>)}
      </section>
      <aside className="space-y-4 min-w-0"><h2 className="font-semibold">Shot inspector</h2>{shot&&<>
        <Field label="Shot prompt" value={shot.spec.prompt} onChange={v=>updateShot(s=>{s.prompt=v;})} multiline/>
        <Field label="Negative prompt" value={shot.spec.negativePrompt} onChange={v=>updateShot(s=>{s.negativePrompt=v;})} multiline/>
        <label className="block text-sm">Duration seconds<input className={inputClass} type="number" min={1} max={60} value={shot.spec.durationSeconds} onChange={e=>updateShot(s=>{s.durationSeconds=Number(e.target.value);})}/></label>
        <label className="block text-sm">Shot type<select className={inputClass} value={shot.spec.shotType} onChange={e=>updateShot(s=>{s.shotType=e.target.value as ShotSpec['shotType'];})}>{['CHARACTER','ACTION','DIALOGUE','ESTABLISHING','BROLL','INSERT','PRODUCT','OTHER'].map(t=><option key={t}>{t}</option>)}</select></label>
        <div className="block text-sm">
          <label htmlFor="shot-camera-angle" className="block text-sm">Camera angle</label>
          <select
            id="shot-camera-angle"
            className={inputClass}
            value={shot.spec.schemaVersion === '2' ? shot.spec.camera.angle : ''}
            onChange={e=>{
              const chosen = e.target.value as CameraAngle | '';
              if (!chosen) return;
              edit(c=>{
                const cur = c.scenes[selected.scene].shots[selected.shot];
                cur.spec = createShotSpecV2({
                  ...cur.spec,
                  camera: { angle: chosen, framing: cur.spec.camera.framing, movement: cur.spec.camera.movement },
                });
              });
            }}
          >
            {shot.spec.schemaVersion === '1' && <option value="">Unspecified — legacy</option>}
            {CAMERA_ANGLES.map(a=><option key={a} value={a}>{a}</option>)}
          </select>
        </div>
        <Field label="Camera framing" value={shot.spec.camera.framing} onChange={v=>updateShot(s=>{s.camera.framing=v;})}/><Field label="Camera movement" value={shot.spec.camera.movement} onChange={v=>updateShot(s=>{s.camera.movement=v;})}/>
        {(['locationId','styleRefId'] as const).map(field=><label key={field} className="block text-sm">{field==='locationId'?'Shot location':'Visual style'}<select className={inputClass} value={shot.spec[field]} onChange={e=>updateShot(s=>{s[field]=e.target.value;if(field==='locationId'){s.continuity.start.locationId=e.target.value;s.continuity.end.locationId=e.target.value;}})}>{content.storyBible[field==='locationId'?'locations':'styleRefs'].map(d=><option value={d.id} key={d.id}>{d.name}</option>)}</select></label>)}
        <section aria-label="Media Generation & Review" className="space-y-3 rounded border border-zinc-800 bg-zinc-900/50 p-3">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">Media Generation & Review</h3>
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] text-zinc-500 font-mono">MODE:</span>
              <button
                type="button"
                onClick={() => setExecutionMode(m => m === 'REPLAY' ? 'LIVE' : 'REPLAY')}
                className={`px-1.5 py-0.5 text-[10px] font-mono font-semibold rounded border transition-colors ${
                  executionMode === 'REPLAY'
                    ? 'bg-amber-950/60 text-amber-400 border-amber-800/60 hover:bg-amber-900/40'
                    : 'bg-emerald-950/60 text-emerald-400 border-emerald-800/60 hover:bg-emerald-900/40'
                }`}
                title="Toggle between REPLAY (safe test fixtures) and LIVE (real provider API charges)"
              >
                {executionMode}
              </button>
            </div>
          </div>

          {/* Keyframe Section */}
          <div className="space-y-2 rounded border border-zinc-800/80 bg-zinc-950/60 p-2.5">
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium text-zinc-300">1. Reference Keyframe</span>
              <div className="flex items-center gap-1">
                <span className={`px-1.5 py-0.5 text-[10px] font-mono rounded ${
                  isKeyframeRequired ? 'bg-amber-950 text-amber-300 border border-amber-800/50' : 'bg-zinc-800 text-zinc-400'
                }`}>
                  {shotRev?.policy.effectiveRequirement ?? 'REQUIRED'}
                </span>
                {currentMedia.keyframeApproved ? (
                  <span className="px-1.5 py-0.5 text-[10px] font-mono bg-emerald-950 text-emerald-300 rounded border border-emerald-800/60">
                    APPROVED
                  </span>
                ) : currentMedia.keyframePending ? (
                  <span className="px-1.5 py-0.5 text-[10px] font-mono bg-amber-950 text-amber-300 rounded border border-amber-800/60">
                    PENDING REVIEW
                  </span>
                ) : (
                  <span className="px-1.5 py-0.5 text-[10px] font-mono bg-zinc-800 text-zinc-400 rounded">
                    NONE
                  </span>
                )}
              </div>
            </div>
            <p className="text-xs text-zinc-400">Keyframe: {shotRev?.policy.effectiveRequirement ?? 'Classified on save'}</p>

            {!activeImageRateCard && (
              <p className="text-[11px] text-rose-400/90 bg-rose-950/30 border border-rose-900/50 rounded p-1.5">
                No active rate card for GEMINI (IMAGE). Generation disabled.
              </p>
            )}

            <div className="flex gap-2">
              <Button
                variant="outline"
                type="button"
                disabled={disabled || !shot.id || !shotRev || !isStoryApproved || !activeImageRateCard || previewLoadingKind === 'IMAGE'}
                onClick={() => void fetchPreview('IMAGE')}
                className="text-xs h-8 border-zinc-700"
              >
                {previewLoadingKind === 'IMAGE' ? 'Previewing…' : 'Preview Keyframe'}
              </Button>
              <Button
                variant="outline"
                type="button"
                disabled={
                  disabled ||
                  !shot.id ||
                  !shotRev ||
                  !activeImageRateCard ||
                  Boolean(generatingKind) ||
                  Boolean(pendingAttempt && (pendingAttempt.shotId !== shot.id || pendingAttempt.kind !== 'IMAGE'))
                }
                onClick={() => void handleGenerate('IMAGE')}
                className="flex-1 text-xs h-8 border-zinc-700 hover:border-zinc-500"
              >
                {generatingKind === 'IMAGE' ? `Generating (${generatingProgress})…` : 'Generate Keyframe'}
              </Button>
              {shot.id && shotRev && (
                <Button
                  variant="outline"
                  type="button"
                  onClick={() => setKeyframeModalOpen(true)}
                  className="text-xs h-8 border-amber-600/50 text-amber-300 hover:bg-amber-950/40"
                >
                  Review KF
                </Button>
              )}
            </div>
            {imagePreview && (
              <div className="mt-2 rounded border border-zinc-800 bg-zinc-900/60 p-2 text-[11px] space-y-1" data-testid="image-preview-panel">
                <p className="font-mono text-zinc-400">Preview: {imagePreview.previewHash.slice(0, 12)}… · {imagePreview.template.modelId} · {imagePreview.template.prompt.length} chars</p>
                {imagePreview.template.fixtureId && <p className="font-mono text-amber-300">Fixture: {imagePreview.template.fixturePackVersion}/{imagePreview.template.fixtureId}</p>}
                <pre className="whitespace-pre-wrap text-zinc-200 font-sans text-[11px] max-h-28 overflow-y-auto">{imagePreview.template.prompt}</pre>
                {imagePreview.template.negativePrompt && <p className="text-zinc-400">Negative: {imagePreview.template.negativePrompt}</p>}
                <p className="text-zinc-400">Input references: {imagePreview.template.inputAssets.length} ({imagePreview.template.inputAssets.map(a => a.role).join(', ') || 'none'})</p>
              </div>
            )}
          </div>

          {/* Video Section */}
          <div className="space-y-2 rounded border border-zinc-800/80 bg-zinc-950/60 p-2.5">
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium text-zinc-300">2. Video Clip</span>
              <div className="flex items-center gap-1">
                {currentMedia.videoApproved ? (
                  <span className="px-1.5 py-0.5 text-[10px] font-mono bg-emerald-950 text-emerald-300 rounded border border-emerald-800/60">
                    APPROVED
                  </span>
                ) : currentMedia.videoPending ? (
                  <span className="px-1.5 py-0.5 text-[10px] font-mono bg-amber-950 text-amber-300 rounded border border-amber-800/60">
                    PENDING REVIEW
                  </span>
                ) : (
                  <span className="px-1.5 py-0.5 text-[10px] font-mono bg-zinc-800 text-zinc-400 rounded">
                    NONE
                  </span>
                )}
              </div>
            </div>

            <label className="block text-xs text-zinc-400">
              Provider / Model
              <select
                className={`${inputClass} mt-1 h-8 text-xs`}
                value={selectedVideoProvider}
                onChange={e => setSelectedVideoProvider(e.target.value as 'RUNWAY' | 'FAL_KLING' | 'LOCAL_PAN_ZOOM')}
              >
                <option value="RUNWAY">Runway Gen-4 Turbo (I2V)</option>
                <option value="FAL_KLING">fal.ai Kling v3 Pro (I2V)</option>
                <option value="LOCAL_PAN_ZOOM">Local Pan/Zoom (Cost-saving static)</option>
              </select>
            </label>

            {/* Gating Notices */}
            {!isStoryApproved ? (
              <p className="text-[11px] text-amber-400/90 bg-amber-950/30 border border-amber-900/50 rounded p-1.5">
                Story revision must be APPROVED before video dispatch.
              </p>
            ) : isVideoBlockedByKeyframe ? (
              <p className="text-[11px] text-amber-400/90 bg-amber-950/30 border border-amber-900/50 rounded p-1.5">
                An approved keyframe is required before video generation (all available video options are image-driven).
              </p>
            ) : !activeVideoRateCard ? (
              <p className="text-[11px] text-rose-400/90 bg-rose-950/30 border border-rose-900/50 rounded p-1.5">
                No active rate card for {selectedVideoProvider}. Generation disabled.
              </p>
            ) : null}

            <div className="flex gap-2">
              <Button
                variant="outline"
                type="button"
                disabled={disabled || !shot.id || !shotRev || !isStoryApproved || isVideoBlockedByKeyframe || !activeVideoRateCard || previewLoadingKind === 'VIDEO'}
                onClick={() => void fetchPreview('VIDEO')}
                className="text-xs h-8 border-zinc-700"
              >
                {previewLoadingKind === 'VIDEO' ? 'Previewing…' : 'Preview Video'}
              </Button>
              <Button
                variant="outline"
                type="button"
                disabled={
                  disabled ||
                  !shot.id ||
                  !shotRev ||
                  !isStoryApproved ||
                  isVideoBlockedByKeyframe ||
                  !activeVideoRateCard ||
                  Boolean(generatingKind) ||
                  Boolean(pendingAttempt && (pendingAttempt.shotId !== shot.id || pendingAttempt.kind !== 'VIDEO'))
                }
                onClick={() => void handleGenerate('VIDEO')}
                className="flex-1 text-xs h-8 border-zinc-700 hover:border-zinc-500 disabled:opacity-50"
              >
                {generatingKind === 'VIDEO' ? `Generating (${generatingProgress})…` : 'Generate Video'}
              </Button>
              {shot.id && shotRev && (
                <Button
                  variant="outline"
                  type="button"
                  onClick={() => setVideoModalOpen(true)}
                  className="text-xs h-8 border-amber-600/50 text-amber-300 hover:bg-amber-950/40"
                >
                  Review Video
                </Button>
              )}
            </div>
            {videoPreview && (
              <div className="mt-2 rounded border border-zinc-800 bg-zinc-900/60 p-2 text-[11px] space-y-1" data-testid="video-preview-panel">
                <p className="font-mono text-zinc-400">Preview: {videoPreview.previewHash.slice(0, 12)}… · {videoPreview.template.modelId} · {videoPreview.template.durationSeconds}s · {videoPreview.template.prompt.length} chars</p>
                {videoPreview.template.fixtureId && <p className="font-mono text-amber-300">Fixture: {videoPreview.template.fixturePackVersion}/{videoPreview.template.fixtureId}</p>}
                <pre className="whitespace-pre-wrap text-zinc-200 font-sans text-[11px] max-h-28 overflow-y-auto">{videoPreview.template.prompt}</pre>
                <p className="text-zinc-400">Inputs: {videoPreview.template.inputAssets.map(a => `${a.role}:${a.assetId.slice(0, 8)}`).join(', ')}</p>
              </div>
            )}
            {previewError && <p role="alert" className="text-[11px] text-rose-300">{previewError}</p>}
          </div>

          {/* Preserved Pending / Uncertain Attempt Recovery Widget */}
          {pendingAttempt && pendingAttempt.shotId === shot.id && (
            <div className="p-2.5 rounded bg-amber-950/50 border border-amber-700/80 text-xs space-y-1.5" data-testid="pending-attempt-banner">
              <div className="flex justify-between items-start">
                <span className="font-semibold text-amber-300">
                  Uncertain Attempt ({pendingAttempt.kind} · {pendingAttempt.provider})
                </span>
                <span className="text-[10px] font-mono text-amber-400/80 bg-amber-900/60 px-1 py-0.5 rounded border border-amber-700/60">
                  RETRY KEY PRESERVED
                </span>
              </div>
              <p className="text-[11px] text-zinc-300">
                A prior attempt dispatch may have committed. Retry to preserve the exact request identity without duplicate billing.
              </p>
              <p className="text-[10px] text-zinc-400 font-mono break-all">
                Key: {pendingAttempt.key}
              </p>
              <div className="flex gap-2 pt-1">
                <Button
                  variant="outline"
                  type="button"
                  disabled={Boolean(generatingKind)}
                  onClick={() => void handleGenerate(pendingAttempt.kind, pendingAttempt)}
                  className="flex-1 text-xs h-7 border-amber-600 text-amber-300 hover:bg-amber-900/50"
                >
                  Retry same attempt
                </Button>
                <Button
                  variant="outline"
                  type="button"
                  disabled={Boolean(generatingKind)}
                  onClick={() => {
                    if (window.confirm('Discard pending attempt record? An uncertain request may already have committed on the ledger.')) {
                      try {
                        sessionStorage.removeItem(attemptSlot);
                      } catch {}
                      setPendingAttempt(null);
                    }
                  }}
                  className="text-xs h-7 border-zinc-700 text-zinc-400 hover:text-zinc-200"
                >
                  Discard
                </Button>
              </div>
            </div>
          )}

          {/* Cross-Shot Pending Attempt Notice */}
          {pendingAttempt && pendingAttempt.shotId !== shot.id && (
            <div className="p-2.5 rounded bg-amber-950/40 border border-amber-800 text-xs space-y-1" data-testid="cross-shot-pending-banner">
              <div className="flex justify-between items-start">
                <span className="font-semibold text-amber-300">
                  Unresolved Attempt on Another Shot
                </span>
                <span className="text-[10px] font-mono text-amber-400/80 bg-amber-900/60 px-1 py-0.5 rounded border border-amber-700/60">
                  LOCKED
                </span>
              </div>
              <p className="text-[11px] text-zinc-300">
                An attempt on another shot ({pendingAttempt.kind} · {pendingAttempt.provider}) is pending resolution. Please resolve or discard it before dispatching new attempts.
              </p>
            </div>
          )}

          {/* Active Generation Status / Error */}
          {generatingKind && (
            <div className="flex items-center gap-2 p-2 bg-amber-950/20 border border-amber-800/40 rounded text-xs text-amber-300">
              <span className="w-2 h-2 rounded-full bg-amber-400 animate-ping" />
              <span>Generating {generatingKind} via {executionMode} mode: {generatingProgress}…</span>
            </div>
          )}

          {generationError && (
            <div className="p-2 bg-rose-950/30 border border-rose-800/50 rounded text-xs text-rose-300">
              <div className="flex justify-between items-start">
                <span>{generationError}</span>
                <button
                  type="button"
                  onClick={() => setGenerationError(null)}
                  className="text-zinc-500 hover:text-zinc-300 ml-2"
                >
                  ✕
                </button>
              </div>
            </div>
          )}
        </section>
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
          <Button variant="outline" onClick={()=>{
            if (shot.spec.schemaVersion === '1') {
              setDuplicateV1Angle('EYE_LEVEL');
              return;
            }
            edit(c=>{c.scenes[selected.scene].shots.splice(selected.shot+1,0,{clientRef:`shot-${crypto.randomUUID()}`,spec:structuredClone(shot.spec)});});
          }}>Duplicate shot</Button>
          {duplicateV1Angle && shot.spec.schemaVersion === '1' && (
            <div className="w-full space-y-2 rounded border border-amber-700/60 bg-zinc-900/70 p-2 text-xs">
              <label className="block">
                Select camera angle to duplicate legacy shot
                <select className={inputClass} value={duplicateV1Angle} onChange={e=>setDuplicateV1Angle(e.target.value as CameraAngle)}>
                  {CAMERA_ANGLES.map(a=><option key={a} value={a}>{a}</option>)}
                </select>
              </label>
              <div className="flex gap-2">
                <Button type="button" onClick={()=>{
                  const nextSpec = createShotSpecV2({ ...shot.spec, camera: { angle: duplicateV1Angle, framing: shot.spec.camera.framing, movement: shot.spec.camera.movement } });
                  edit(c=>{c.scenes[selected.scene].shots.splice(selected.shot+1,0,{clientRef:`shot-${crypto.randomUUID()}`,spec:nextSpec});});
                  setDuplicateV1Angle(null);
                }}>Confirm duplicate</Button>
                <Button type="button" variant="outline" onClick={()=>setDuplicateV1Angle(null)}>Cancel</Button>
              </div>
            </div>
          )}
          <Button variant="outline" disabled={content.scenes[selected.scene].shots.length<2} onClick={()=>{edit(c=>{c.scenes[selected.scene].shots.splice(selected.shot,1);});setSelected(s=>({...s,shot:0}));}}>Remove shot</Button>
        </div>
        {content.scenes.length>1&&<label className="block text-sm">Move to scene<select className={inputClass} value={selected.scene} onChange={e=>{const target=Number(e.target.value);edit(c=>{const [moved]=c.scenes[selected.scene].shots.splice(selected.shot,1);c.scenes[target].shots.push(moved);});setSelected({scene:target,shot:content.scenes[target].shots.length});}}>{content.scenes.map((s,i)=><option key={s.clientRef} value={i}>{s.title}</option>)}</select></label>}
      </>}</aside>
    </fieldset>}
    <section className="mt-8 border-t border-zinc-800 py-5"><h2 className="font-semibold mb-3">Validation and approval evidence</h2>{historicalValidation&&<p role="status" className="text-amber-300">Historical evidence uses {board?.validation?.ruleSetVersion}; current G1 requires {board?.currentRuleSetVersion}. Create and approve a successor revision for current acceptance.</p>}{board?.validation?.findings.length===0&&!historicalValidation&&<p>No blocking findings under {board.currentRuleSetVersion}.</p>}{board?.validation?.findings.map(f=><div key={f.fingerprint} className="my-3 text-sm"><p className={f.severity==='ERROR'?'text-rose-300':'text-amber-300'}>{f.severity}: {f.message}</p><p className="text-zinc-500">{f.path}</p>{board.waivers.some(w=>w.findingFingerprint===f.fingerprint)?<p>Waived with producer reason.</p>:f.waivable&&<Button variant="outline" disabled={disabled||dirty||!['PLANNED','IN_REVIEW'].includes(board.active?.state??'')} onClick={()=>{const reason=window.prompt('Reason for accepting this wardrobe/held-prop mismatch');if(reason?.trim())mutate('waivers',{...token,findingFingerprint:f.fingerprint,reason});}}>Waive finding</Button>}</div>)}{board?.approval&&<p className={historicalValidation?'text-amber-300':'text-emerald-300'}>Approval recorded for revision {board.revision?.revisionNo}. {historicalValidation?'This remains historical audit evidence only.':'Evidence is bound to this content, waiver set, and current ruleset.'}</p>}</section>
    <section className="border-t border-zinc-800 py-5"><h2 className="font-semibold mb-3">Revision history</h2><div className="flex gap-2 flex-wrap">{board?.history.map(r=><Button key={r.id} variant="outline" disabled={busy||dirty||Boolean(pending)} onClick={()=>void load(r.id).catch(()=>setError('Unable to read history.'))}>Revision {r.revisionNo} · {r.state}</Button>)}</div></section>
    {shot?.id && board?.revision?.shotRevisions[shot.id] && (
      <>
        <KeyframeReviewModal
          filmId={filmId}
          shotId={shot.id}
          shotRevisionId={board.revision.shotRevisions[shot.id].id}
          keyframeRequirement={board.revision.shotRevisions[shot.id].policy.effectiveRequirement}
          isOpen={keyframeModalOpen}
          onClose={() => setKeyframeModalOpen(false)}
          onReviewSubmitted={() => {
            void load();
            if (content) void refreshShotMedia(content.scenes.flatMap(s => s.shots));
          }}
        />
        <VideoReviewModal
          filmId={filmId}
          shotId={shot.id}
          shotRevisionId={board.revision.shotRevisions[shot.id].id}
          shotPrompt={shot.spec.prompt}
          isOpen={videoModalOpen}
          onClose={() => setVideoModalOpen(false)}
          onReviewSubmitted={() => {
            void load();
            if (content) void refreshShotMedia(content.scenes.flatMap(s => s.shots));
          }}
        />
      </>
    )}
  </div>;
}
