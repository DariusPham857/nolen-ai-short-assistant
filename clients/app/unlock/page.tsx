'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '../../components/ui/button';
import { errorMessage } from '../../lib/api';

/** Unlock token stays in component memory and is never stored in browser storage. */
export default function Unlock() {
  const router=useRouter(); const [token,setToken]=useState('');const [error,setError]=useState('');const [busy,setBusy]=useState(false);
  return <section className="max-w-md mx-auto py-12"><p className="text-xs tracking-widest uppercase text-zinc-400 mb-3">Operator access</p><h1 className="text-2xl font-bold mb-3">Unlock your workspace</h1><p className="text-sm text-zinc-400 mb-8">Enter the operator token configured on this machine.</p>
    <form className="space-y-5" onSubmit={event=>{event.preventDefault();setBusy(true);setError('');void(async()=>{
      try {const response=await fetch('/api/operator/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token})});
        if(!response.ok){setError(await errorMessage(response));return;}
        setToken('');
        const next=new URLSearchParams(window.location.search).get('next');
        router.push(next && /^\/films\/(new|[0-9a-f-]+\/(brief|storyboard))$/.test(next)?next:'/films/new');
      } catch {setError('Unable to reach the local server. Try again.');} finally {setBusy(false);}
    })();}}>
      <div><label htmlFor="token">Operator token</label><input id="token" type="password" autoComplete="off" required value={token} onChange={e=>setToken(e.target.value)} disabled={busy}/></div>
      {error&&<p role="alert" className="text-rose-300 text-sm">{error}</p>}
      <Button type="submit" disabled={busy}>{busy?'Unlocking…':'Unlock workspace'}</Button>
    </form></section>;
}
