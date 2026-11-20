'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { normalizeFilm, usdToMicros, formatMicros, filmDtoSchema, type CreateFilm } from '@nolen/contracts';
import { Button } from './ui/button';
import { Navigation } from './navigation';
import { errorMessage } from '../lib/api';

const storageKey='nolen-pending-film';
type Pending={key:string;payload:CreateFilm};

/** Persist uncertainty before dispatch; only retry the same canonical request until resolved. */
export function CreateFilmForm() {
  const router=useRouter();
  const [pending,setPending]=useState<Pending|null>(null);const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [ready,setReady]=useState(false);
  const [storageBlocked,setStorageBlocked]=useState(false);
  const [draft,setDraft]=useState<CreateFilm|null>(null);
  useEffect(()=>{
    try { const stored=sessionStorage.getItem(storageKey);
      if(stored){const parsed:unknown=JSON.parse(stored);
        if(typeof parsed==='object'&&parsed!==null&&'key' in parsed&&typeof parsed.key==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parsed.key)&&'payload' in parsed){setPending({key:parsed.key,payload:normalizeFilm(parsed.payload)});}
        else {setStorageBlocked(true);setError('Stored create request could not be read. Cancel it before creating a new Film.');}
      }
    } catch {setStorageBlocked(true);setError('Pending request storage is unavailable or invalid. Resolve it before submitting.');}
    setReady(true);
  },[]);

  async function send(request:Pending) {
    setBusy(true);setError('');
    try {
      const response=await fetch('/api/films',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':request.key},body:JSON.stringify(request.payload),signal:AbortSignal.timeout(15000)});
      if(response.status===201){const film=filmDtoSchema.parse(await response.json());sessionStorage.removeItem(storageKey);setPending(null);router.push(`/films/${film.id}/brief`);return;}
      if(response.status===401){router.push('/unlock?next=/films/new');return;}
      setError(await errorMessage(response));
      if(response.status>=400&&response.status<500){setDraft(request.payload);sessionStorage.removeItem(storageKey);setPending(null);}
    } catch {setError('Creation is not confirmed. Retry the saved request to avoid a duplicate Film.');}
    finally {setBusy(false);}
  }

  return <><div className="flex flex-wrap justify-between gap-4 mb-10"><div><p className="text-xs uppercase tracking-widest text-zinc-400 mb-2">Film / Brief</p><h1 className="text-2xl font-bold">Create Film</h1></div><Navigation/></div>
    <p className="text-zinc-400 text-sm mb-8">Set the brief and production constraints. Your Film starts as a draft.</p>
    {pending?<section className="border border-amber-700 bg-zinc-900 rounded-lg p-6 space-y-4"><h2 className="font-semibold">Unconfirmed create request</h2><p className="text-sm text-zinc-300">{pending.payload.title} · ${formatMicros(pending.payload.budgetLimitUsdMicros)}</p><p className="text-sm text-zinc-400">A Film may already exist. Retry this request to retrieve the same Film.</p><div className="flex gap-3"><Button disabled={busy} onClick={()=>{void send(pending);}}>{busy?'Confirming…':'Retry saved request'}</Button><Button variant="outline" disabled={busy} onClick={()=>{if(window.confirm('A Film may already have been created. Cancelling does not delete it. Continue?')){sessionStorage.removeItem(storageKey);setPending(null);setError('');}}}>Cancel saved request</Button></div></section>:
    <form className="space-y-6 max-w-2xl" onSubmit={event=>{event.preventDefault();const form=new FormData(event.currentTarget);setError('');
      try {const payload=normalizeFilm({title:form.get('title'),brief:form.get('brief'),budgetLimitUsdMicros:usdToMicros(String(form.get('budget'))),durationTargetSeconds:Number(form.get('duration')),aspectRatio:'9:16',styleNotes:form.get('style')});
        const request={key:crypto.randomUUID(),payload};sessionStorage.setItem(storageKey,JSON.stringify(request));setPending(request);void send(request);
      } catch {setError('Check all fields. Budget must be within the supported limit, with up to six decimal places.');}
    }}>
      <div><label htmlFor="title">Film title</label><input id="title" name="title" required maxLength={255} defaultValue={draft?.title}/></div>
      <div><label htmlFor="brief">Production brief</label><textarea id="brief" name="brief" required maxLength={10000} rows={6} defaultValue={draft?.brief}/></div>
      <div className="grid sm:grid-cols-3 gap-5"><div><label htmlFor="duration">Duration (seconds)</label><input id="duration" name="duration" type="number" min={30} max={60} step={1} defaultValue={draft?.durationTargetSeconds??30} required/></div><div><label htmlFor="budget">Budget limit (USD)</label><input id="budget" name="budget" inputMode="decimal" defaultValue={draft?formatMicros(draft.budgetLimitUsdMicros):'0.000000'} required/></div><div><label htmlFor="ratio">Aspect ratio</label><input id="ratio" value="9:16" readOnly/></div></div>
      <div><label htmlFor="style">Audience / visual style (optional)</label><textarea id="style" name="style" maxLength={2000} rows={3} defaultValue={draft?.styleNotes??''}/></div>
      <Button type="submit" disabled={!ready||busy||storageBlocked}>Create draft Film</Button>
    </form>}
    {error&&<p role="alert" aria-label="Create Film error" className="text-sm text-rose-300 mt-5">{error}</p>}
    {storageBlocked&&<Button variant="outline" onClick={()=>{if(window.confirm('A Film may already exist. Discard unreadable pending data?')){try{sessionStorage.removeItem(storageKey);setStorageBlocked(false);setError('');}catch{setError('Browser storage unavailable. Enable session storage to create a Film.');}}}}>Discard unreadable pending request</Button>}
  </>;
}
