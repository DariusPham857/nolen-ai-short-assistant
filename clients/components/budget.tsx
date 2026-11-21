'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { formatMicros, moneyProjectionSchema, updateBudgetSchema, usdToMicros, type MoneyProjection } from '@nolen/contracts';
import { Button } from './ui/button';
import { Navigation } from './navigation';
import { errorMessage } from '../lib/api';

type Budget=MoneyProjection;
function usd(value:string){return `${value.startsWith('-')?'-':''}$${formatMicros(value.startsWith('-')?value.slice(1):value)}`;}

/** Exact budget projection; the browser never performs financial arithmetic. */
export function BudgetWorkspace({filmId}:{filmId:string}){
  const router=useRouter();const [budget,setBudget]=useState<Budget|null>(null);const [error,setError]=useState('');const [busy,setBusy]=useState(false);
  async function load(signal?:AbortSignal){
    const response=await fetch(`/api/films/${filmId}/budget`,{cache:'no-store',signal});
    if(response.status===401){router.push(`/unlock?next=/films/${filmId}/budget`);return;}
    if(!response.ok){setError(await errorMessage(response));return;}
    setBudget(moneyProjectionSchema.parse(await response.json()));
  }
  useEffect(()=>{const controller=new AbortController();void load(controller.signal).catch(()=>{if(!controller.signal.aborted)setError('Unable to load budget.');});return()=>controller.abort();},[filmId]);
  if(!budget)return <div role="status">{error||'Loading budget…'}</div>;
  const cards=[['Limit',budget.budgetLimitUsdMicros],['Spent',budget.actualSpentUsdMicros],['Reserved',budget.reservedOpenUsdMicros],['Pending',budget.pendingLiabilityUsdMicros],['Available',budget.availableUsdMicros]];
  return <div><div className="flex justify-between flex-wrap gap-4 mb-8"><div><p className="text-xs uppercase tracking-widest text-zinc-400">Financial Core · G2</p><h1 className="text-2xl font-bold">Budget status</h1></div><Navigation/></div>
    {budget.warning&&<p role="status" className="border border-amber-600 rounded p-3 mb-5 text-amber-200">Budget exposure reached the 80% warning threshold.</p>}
    <div className="grid sm:grid-cols-5 gap-3 mb-8">{cards.map(([label,value])=><section key={label} className="border border-zinc-700 rounded p-4"><h2 className="text-xs uppercase text-zinc-400">{label}</h2><p className="font-mono mt-2">{usd(value)}</p></section>)}</div>
    <form className="max-w-xl space-y-4 border-t border-zinc-800 pt-6" onSubmit={event=>{event.preventDefault();setBusy(true);setError('');void(async()=>{try{const form=new FormData(event.currentTarget);const input=updateBudgetSchema.parse({budgetLimitUsdMicros:usdToMicros(String(form.get('limit'))),reason:form.get('reason'),expectedVersion:budget.version});const response=await fetch(`/api/films/${filmId}/budget`,{method:'PATCH',headers:{'Content-Type':'application/json','Idempotency-Key':crypto.randomUUID()},body:JSON.stringify(input)});if(!response.ok){setError(await errorMessage(response));if(response.status===409)await load();return;}setBudget(moneyProjectionSchema.parse(await response.json()));event.currentTarget.reset();}catch{setError('Enter an exact nonnegative USD limit and a reason.');}finally{setBusy(false);}})();}}>
      <h2 className="font-semibold">Change budget limit</h2><div><label htmlFor="limit">New limit (USD)</label><input id="limit" name="limit" inputMode="decimal" required defaultValue={formatMicros(budget.budgetLimitUsdMicros)}/></div><div><label htmlFor="reason">Audit reason</label><textarea id="reason" name="reason" required maxLength={1000} rows={3}/></div><Button type="submit" disabled={busy}>{busy?'Saving…':'Update limit'}</Button>
    </form>{error&&<p role="alert" className="text-rose-300 mt-4">{error}</p>}
  </div>;
}

