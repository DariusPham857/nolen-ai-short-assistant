'use client';
import { use, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { filmDtoSchema, formatMicros, type FilmDto } from '@nolen/contracts';
import { Navigation } from '../../../../components/navigation';
import { errorMessage } from '../../../../lib/api';

/** Read from authenticated no-store API after hydration; no operator data in static output. */
export default function FilmBrief({params}:{params:Promise<{id:string}>}) {
  const {id}=use(params);const router=useRouter();const [film,setFilm]=useState<FilmDto|null>(null);const [error,setError]=useState('');
  useEffect(()=>{const controller=new AbortController();void(async()=>{
    try {const response=await fetch(`/api/films/${id}`,{cache:'no-store',signal:controller.signal});
      if(response.status===401){router.push(`/unlock?next=/films/${id}/brief`);return;}
      if(!response.ok){setError(await errorMessage(response));return;}
      setFilm(filmDtoSchema.parse(await response.json()));
    } catch {if(!controller.signal.aborted)setError('Unable to read Film. Reload to retry.');}
  })();return()=>controller.abort();},[id,router]);
  if(error)return <p role="alert" className="text-rose-300">{error}</p>;
  if(!film)return <div role="status" aria-label="Loading Film" className="animate-pulse space-y-4"><div className="h-10 bg-zinc-800 rounded w-2/3"/><div className="h-60 bg-zinc-900 rounded"/></div>;
  return <><div className="flex justify-between flex-wrap gap-4 mb-10"><div><p className="text-xs uppercase tracking-widest text-zinc-400 mb-2">Film Brief — Read Only</p><h1 className="text-2xl font-bold">{film.title}</h1></div><Navigation/></div>
    <div className="flex gap-4 flex-wrap mb-8 text-sm"><span className="rounded border border-zinc-700 px-3 py-1">{film.status}</span><span>{film.durationTargetSeconds}s · {film.aspectRatio}</span><span className="font-mono">Budget limit: ${formatMicros(film.budgetLimitUsdMicros)}</span><Link className="text-amber-300 underline" href={`/films/${id}/storyboard`}>Open storyboard</Link><Link className="text-amber-300 underline" href={`/films/${id}/budget`}>Budget status</Link></div>
    <section className="border-t border-zinc-800 py-6"><h2 className="font-semibold mb-4">Production brief</h2><p className="whitespace-pre-wrap text-zinc-300">{film.brief}</p></section>
    {film.styleNotes&&<section className="border-t border-zinc-800 py-6"><h2 className="font-semibold mb-4">Audience / visual style</h2><p className="whitespace-pre-wrap text-zinc-300">{film.styleNotes}</p></section>}
  </>;
}
