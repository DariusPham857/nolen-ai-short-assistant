'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from './ui/button';
import { errorMessage } from '../lib/api';

/** Report logout only after durable server revocation; preserve errors in-place. */
export function Navigation() {
  const router=useRouter();
  const [error,setError]=useState('');
  return <><nav className="flex gap-4 items-center"><Link href="/films/new">Create Film</Link>
    <Button variant="outline" onClick={() => { void (async()=>{
      try {
        const response=await fetch('/api/operator/session',{method:'DELETE'});
        if(!response.ok){setError(await errorMessage(response));return;}
        router.push('/unlock');router.refresh();
      } catch {setError('Logout could not be confirmed. Try again.');}
    })(); }}>Lock workspace</Button></nav>{error && <p role="alert">{error}</p>}</>;
}
