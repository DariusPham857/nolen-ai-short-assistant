import { NextResponse, type NextRequest } from 'next/server';

/** Enforce the canonical Host for pages/assets as well as Hono APIs. */
export function proxy(request:NextRequest) {
  if(request.headers.get('host')!=='127.0.0.1:3000') {
    return NextResponse.json({error:{code:'HOST_REJECTED',message:'Unsupported host',requestId:crypto.randomUUID()}},{status:403,headers:{'Cache-Control':'no-store'}});
  }
  return NextResponse.next();
}
