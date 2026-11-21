import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { z } from 'zod';
import { storyContentSchema, storyStateSchema, policySchema, type StoryContent, type Expected, type StorySnapshot, type Storyboard, type Validation } from '@nolen/contracts';
import { pgClient } from '../db/index.js';
import { ApiFailure } from '../http/errors.js';
import { hash, policy, referenceErrors, RULESET, shotDependency, validate } from './domain.js';

type Tx=postgres.TransactionSql;
const storedSchema=z.object({content:storyContentSchema,shotRevisions:z.record(z.object({id:z.string().uuid(),dependencyHash:z.string(),policy:policySchema}))});
type RevisionRow={id:string;parent_id:string|null;revision_no:number;state:string;state_version:number;content_hash:string;content:unknown};
type ValidationRow={id:string;story_revision_id:string;context:'STORY_APPROVAL';dependency_hash:string;rule_set_version:string;findings:Validation['findings']};
export type Receipt={storyRevisionId:string;state:string;stateVersion:number;contentHash:string};
/** Decode persisted content before returning it to an operator. */
function snapshot(row:RevisionRow):StorySnapshot {
  return {id:row.id,parentId:row.parent_id,revisionNo:row.revision_no,state:storyStateSchema.parse(row.state),stateVersion:row.state_version,contentHash:row.content_hash,...storedSchema.parse(row.content)};
}
/** Only a matching active revision/version may mutate; called after the Film row lock. */
function checkExpected(active:StorySnapshot|null,expected:Expected):void {
  if((active?.id??null)!==expected.expectedStoryRevisionId || (active?.stateVersion??0)!==expected.expectedStateVersion)throw new ApiFailure(409,'VERSION_CONFLICT','Reload the current storyboard before changing it');
}
function validationDependency(r:StorySnapshot,target:number,ruleSetVersion:string):string {
  return hash({content:r.content,shots:r.shotRevisions,target,context:'STORY_APPROVAL',ruleSetVersion});
}
function validationDto(row:ValidationRow):Validation {
  return {id:row.id,context:row.context,dependencyHash:row.dependency_hash,ruleSetVersion:row.rule_set_version,findings:row.findings};
}
/** Validation is deterministic persisted evidence, never a command receipt or lifecycle mutation. */
async function validation(tx:Tx,r:StorySnapshot,target:number):Promise<Validation> {
  const dependencyHash=validationDependency(r,target,RULESET);
  const findings=validate(r.content,target);
  if(hash({content:r.content,shotRevisions:r.shotRevisions})!==r.contentHash)throw new ApiFailure(409,'REVISION_INTEGRITY','Stored content does not match its revision hash');
  for(const shot of r.content.scenes.flatMap(s=>s.shots)){
    const stored=r.shotRevisions[shot.id!];
    if(!stored || stored.dependencyHash!==shotDependency(shot.spec,r.content) || hash(stored.policy)!==hash(policy(shot.spec,r.content)))findings.push({fingerprint:hash({id:shot.id,code:'POLICY_RESOLVED'}),code:'POLICY_RESOLVED',severity:'ERROR',path:`shots.${shot.id}.policy`,message:'Shot policy or Bible binding requires a successor revision',waivable:false});
  }
  await tx`INSERT INTO story_validations(id,story_revision_id,context,dependency_hash,rule_set_version,findings)
    VALUES(${randomUUID()},${r.id},'STORY_APPROVAL',${dependencyHash},${RULESET},${JSON.stringify(findings)}::jsonb)
    ON CONFLICT(story_revision_id,context,dependency_hash,rule_set_version) DO NOTHING`;
  const [row]=await tx<{id:string;findings:unknown}[]>`SELECT id,findings FROM story_validations WHERE story_revision_id=${r.id} AND context='STORY_APPROVAL' AND dependency_hash=${dependencyHash} AND rule_set_version=${RULESET}`;
  if(hash(row.findings)!==hash(findings))throw new ApiFailure(409,'VALIDATION_RULESET_MISMATCH','Validation behavior changed without a new rule-set version');
  return {id:row.id,context:'STORY_APPROVAL',dependencyHash,ruleSetVersion:RULESET,findings};
}
/** Shared transaction boundary for Story writes; replay precedes optimistic preconditions. */
export async function command(filmId:string,operator:string,key:string|null,kind:string,input:Expected & {content?:StoryContent;findingFingerprint?:string;reason?:string}):Promise<Receipt|Validation> {
  const fingerprint=hash({kind,input});
  return pgClient.begin('isolation level read committed',async tx=>{
    const [film]=await tx<{id:string;active_story_revision_id:string|null;duration_target_seconds:number}[]>`SELECT id,active_story_revision_id,duration_target_seconds FROM films WHERE id=${filmId} AND operator_id=${operator} FOR UPDATE`;
    if(!film)throw new ApiFailure(404,'FILM_NOT_FOUND','Film not found');
    if(key){
      const [old]=await tx<{request_hash:string;response:Receipt}[]>`SELECT request_hash,response FROM story_mutation_receipts WHERE film_id=${filmId} AND operator_id=${operator} AND key=${key}`;
      if(old){if(old.request_hash!==fingerprint)throw new ApiFailure(409,'IDEMPOTENCY_CONFLICT','Key was used for another command');return old.response;}
    }
    const [row]=film.active_story_revision_id?await tx<RevisionRow[]>`SELECT * FROM story_revisions WHERE id=${film.active_story_revision_id}`:[];
    const active=row?snapshot(row):null;
    checkExpected(active,input);
    let current=active;
    if(kind==='save'){
      if(!input.content)throw new ApiFailure(422,'VALIDATION_ERROR','Story content required');
      const errors=referenceErrors(input.content);
      if(errors.length)throw new ApiFailure(422,'VALIDATION_ERROR','Resolve Story references and structural errors',errors);
      const content=structuredClone(input.content);
      const knownScenes=await tx<{id:string}[]>`SELECT id FROM scenes WHERE film_id=${filmId}`;
      const knownShots=await tx<{id:string}[]>`SELECT id FROM shots WHERE film_id=${filmId}`;
      const shotRevisions:StorySnapshot['shotRevisions']={};
      for(const scene of content.scenes){
        if(scene.id && !knownScenes.some(s=>s.id===scene.id))throw new ApiFailure(404,'SCENE_NOT_FOUND','Scene not found in Film');
        if(!scene.id){scene.id=randomUUID();await tx`INSERT INTO scenes(id,film_id) VALUES(${scene.id},${filmId})`;}
        for(const shot of scene.shots){
          if(shot.id && !knownShots.some(s=>s.id===shot.id))throw new ApiFailure(404,'SHOT_NOT_FOUND','Shot not found in Film');
          const prior=shot.id?active?.shotRevisions[shot.id]:undefined;
          if(shot.id && (!prior || shot.expectedShotRevisionId!==prior.id))throw new ApiFailure(409,'STALE_REVISION','Shot revision changed');
          if(!shot.id){shot.id=randomUUID();await tx`INSERT INTO shots(id,film_id) VALUES(${shot.id},${filmId})`;}
          const dependencyHash=shotDependency(shot.spec,content);
          const derivedPolicy=policy(shot.spec,content);
          const revisionId=prior?.dependencyHash===dependencyHash?prior.id:randomUUID();
          if(revisionId!==prior?.id)await tx`INSERT INTO shot_revisions(id,film_id,shot_id,spec,dependency_hash,policy) VALUES(${revisionId},${filmId},${shot.id},${JSON.stringify(shot.spec)}::jsonb,${dependencyHash},${JSON.stringify(derivedPolicy)}::jsonb)`;
          shotRevisions[shot.id]={id:revisionId,dependencyHash,policy:derivedPolicy};
          delete shot.expectedShotRevisionId;
        }
      }
      const id=randomUUID();const contentHash=hash({content,shotRevisions});
      current={id,parentId:active?.id??null,revisionNo:(active?.revisionNo??0)+1,state:'DRAFT',stateVersion:0,contentHash,content,shotRevisions};
      await tx`INSERT INTO story_revisions(id,film_id,parent_id,revision_no,content,content_hash) VALUES(${id},${filmId},${current.parentId},${current.revisionNo},${JSON.stringify({content,shotRevisions})}::jsonb,${contentHash})`;
      for(const [scenePosition,scene] of content.scenes.entries()){
        await tx`INSERT INTO story_revision_scenes(film_id,story_revision_id,scene_id,position) VALUES(${filmId},${id},${scene.id!},${scenePosition})`;
        for(const [position,shot] of scene.shots.entries())await tx`INSERT INTO story_revision_shots(film_id,story_revision_id,scene_id,shot_id,shot_revision_id,position) VALUES(${filmId},${id},${scene.id!},${shot.id!},${shotRevisions[shot.id!].id},${position})`;
      }
      await tx`UPDATE films SET active_story_revision_id=${id},status='PLANNING',updated_at=now() WHERE id=${filmId}`;
      await validation(tx,current,film.duration_target_seconds);
    }else{
      if(!current)throw new ApiFailure(409,'STORY_REQUIRED','Save a storyboard first');
      const result=await validation(tx,current,film.duration_target_seconds);
      if(kind==='validate')return result;
      const waiverRows=await tx<{id:string;finding_fingerprint:string;dependency_hash:string;actor_id:string;reason:string;created_at:string}[]>`SELECT * FROM story_waivers WHERE story_revision_id=${current.id} ORDER BY id`;
      if(kind==='waiver'){
        if(!['PLANNED','IN_REVIEW'].includes(current.state))throw new ApiFailure(409,'INVALID_STATE','Waivers require an unapproved review revision');
        const finding=result.findings.find(f=>f.fingerprint===input.findingFingerprint && f.waivable && f.severity==='ERROR');
        if(!finding || !input.reason)throw new ApiFailure(422,'WAIVER_NOT_ALLOWED','This finding cannot be waived');
        if(waiverRows.some(w=>w.finding_fingerprint===finding.fingerprint))throw new ApiFailure(409,'WAIVER_EXISTS','Finding already waived');
        await tx`INSERT INTO story_waivers(id,story_revision_id,finding_fingerprint,dependency_hash,actor_id,reason) VALUES(${randomUUID()},${current.id},${finding.fingerprint},${result.dependencyHash},${operator},${input.reason})`;
      }else{
        const transitions:Record<string,{from:string;to:'PLANNED'|'IN_REVIEW'|'APPROVED'}>={ 'mark-planned':{from:'DRAFT',to:'PLANNED'},'submit-review':{from:'PLANNED',to:'IN_REVIEW'},approve:{from:'IN_REVIEW',to:'APPROVED'} };
        const transition=transitions[kind];
        if(!transition || current.state!==transition.from)throw new ApiFailure(409,'INVALID_STATE','Invalid story transition');
        if(kind==='approve'){
          const effective=waiverRows.filter(w=>w.dependency_hash===result.dependencyHash && result.findings.some(f=>f.fingerprint===w.finding_fingerprint && f.waivable));
          const blocking=result.findings.filter(f=>f.severity==='ERROR'&&!effective.some(w=>w.finding_fingerprint===f.fingerprint));
          if(blocking.length)throw new ApiFailure(422,'CONTINUITY_BLOCKED','Resolve blocking findings before approval',blocking);
          const evidence={storyRevisionId:current.id,contentHash:current.contentHash,dependencyHash:result.dependencyHash,ruleSetVersion:RULESET,validationRunId:result.id,waiverIds:effective.map(w=>w.id),waiverSetHash:hash(effective),actorId:operator,approvedAt:new Date().toISOString(),decision:'APPROVED'};
          await tx`INSERT INTO story_approvals(id,story_revision_id,evidence) VALUES(${randomUUID()},${current.id},${JSON.stringify(evidence)}::jsonb)`;
        }
        current={...current,state:transition.to};
      }
      current={...current,stateVersion:current.stateVersion+1};
      await tx`UPDATE story_revisions SET state=${current.state},state_version=${current.stateVersion} WHERE id=${current.id}`;
    }
    if(!current)throw new Error('Story command produced no revision');
    const response:Receipt={storyRevisionId:current.id,state:current.state,stateVersion:current.stateVersion,contentHash:current.contentHash};
    await tx`INSERT INTO story_mutation_receipts(id,film_id,operator_id,key,request_hash,response) VALUES(${randomUUID()},${filmId},${operator},${key!},${fingerprint},${JSON.stringify(response)}::jsonb)`;
    return response;
  });
}

/** Coherent repeatable-read projection; reads never persist validation or alter history. */
export async function readStoryboard(filmId:string,operator:string,revisionId?:string):Promise<Storyboard> {
  return pgClient.begin('isolation level repeatable read read only',async tx=>{
    const [film]=await tx<{active_story_revision_id:string|null;duration_target_seconds:number}[]>`SELECT active_story_revision_id,duration_target_seconds FROM films WHERE id=${filmId} AND operator_id=${operator}`;
    if(!film)throw new ApiFailure(404,'FILM_NOT_FOUND','Film not found');
    const rows=await tx<RevisionRow[]>`SELECT * FROM story_revisions WHERE film_id=${filmId} ORDER BY revision_no DESC`;
    const activeRow=rows.find(r=>r.id===film.active_story_revision_id);const selected=revisionId?rows.find(r=>r.id===revisionId):activeRow;
    if(revisionId&&!selected)throw new ApiFailure(404,'REVISION_NOT_FOUND','Revision not found');
    const revision=selected?snapshot(selected):null;
    const ws=selected?await tx<{id:string;finding_fingerprint:string;reason:string}[]>`SELECT * FROM story_waivers WHERE story_revision_id=${selected.id} ORDER BY id`:[];
    const [approval]=selected?await tx<{evidence:Record<string,unknown>}[]>`SELECT evidence FROM story_approvals WHERE story_revision_id=${selected.id}`:[];
    let v:ValidationRow|undefined;
    if(revision && approval){
      const evidence=z.object({storyRevisionId:z.string().uuid(),contentHash:z.string(),dependencyHash:z.string(),ruleSetVersion:z.string(),validationRunId:z.string().uuid()}).passthrough().safeParse(approval.evidence);
      if(!evidence.success || evidence.data.storyRevisionId!==revision.id || evidence.data.contentHash!==revision.contentHash)throw new ApiFailure(409,'REVISION_INTEGRITY','Approval evidence does not match its StoryRevision');
      [v]=await tx<ValidationRow[]>`SELECT * FROM story_validations WHERE id=${evidence.data.validationRunId} AND story_revision_id=${revision.id} AND context='STORY_APPROVAL'`;
      if(!v || v.dependency_hash!==evidence.data.dependencyHash || v.rule_set_version!==evidence.data.ruleSetVersion)throw new ApiFailure(409,'REVISION_INTEGRITY','Approval validation evidence is missing or inconsistent');
    }else if(revision){
      const currentDependency=validationDependency(revision,film.duration_target_seconds,RULESET);
      [v]=await tx<ValidationRow[]>`SELECT * FROM story_validations WHERE story_revision_id=${revision.id} AND context='STORY_APPROVAL' AND dependency_hash=${currentDependency} AND rule_set_version=${RULESET}`;
      if(!v){
        const policyVersions=new Set(Object.values(revision.shotRevisions).map(s=>s.policy.ruleSetVersion));
        if(policyVersions.size!==1)throw new ApiFailure(409,'REVISION_INTEGRITY','StoryRevision contains inconsistent policy rule-set versions');
        const [storedVersion]=policyVersions;const storedDependency=validationDependency(revision,film.duration_target_seconds,storedVersion);
        [v]=await tx<ValidationRow[]>`SELECT * FROM story_validations WHERE story_revision_id=${revision.id} AND context='STORY_APPROVAL' AND dependency_hash=${storedDependency} AND rule_set_version=${storedVersion}`;
      }
    }
    return {active:activeRow?snapshot(activeRow):null,revision,history:rows.map(r=>({id:r.id,revisionNo:r.revision_no,state:storyStateSchema.parse(r.state)})),currentRuleSetVersion:RULESET,validation:v?validationDto(v):null,waivers:ws.map(w=>({id:w.id,findingFingerprint:w.finding_fingerprint,reason:w.reason})),approval:approval?.evidence??null};
  });
}
