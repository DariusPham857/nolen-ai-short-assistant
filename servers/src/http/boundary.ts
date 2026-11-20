import { Hono, type Context } from 'hono';
import { getCookie } from 'hono/cookie';
import { z } from 'zod';
import { APP_ORIGIN } from '../config/runtime.js';
import { COOKIE, authenticate } from '../auth/sessions.js';
import { IdempotencyConflict } from '../films/repository.js';
import { ApiFailure, failure } from './errors.js';
export const keySchema = z.string().uuid().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);

/** URL IDs have a transport error distinct from body-schema validation. */
export function resourceId(value:string|undefined):string {
  const parsed=z.string().uuid().safeParse(value);
  if(!parsed.success)throw new ApiFailure(400,'INVALID_ID','Invalid resource ID');
  return parsed.data;
}

/** Stream-bound JSON parser, including chunked bodies with absent/lying Content-Length. */
export async function boundedJson(request: Request, limit: number): Promise<unknown> {
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new ApiFailure(415, 'UNSUPPORTED_MEDIA_TYPE', 'Use application/json');
  }
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  if (reader) {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > limit) { await reader.cancel(); throw new ApiFailure(413, 'PAYLOAD_TOO_LARGE', 'Request body exceeds limit'); }
      chunks.push(next.value);
    }
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
  catch { throw new ApiFailure(400, 'INVALID_JSON', 'Malformed JSON'); }
}


/** Common transport and error boundary, including standalone route-group tests. */
export function installBoundary(api:Hono):void {
  api.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    if ((c.req.header('host') ?? new URL(c.req.url).host) !== '127.0.0.1:3000') {
      return failure(c, 403, 'HOST_REJECTED', 'Unsupported host');
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) && c.req.header('origin') !== APP_ORIGIN) {
      return failure(c, 403, 'ORIGIN_REJECTED', 'Unsupported or missing origin');
    }
    await next();
  });

  api.onError((error, c) => {
    if (error instanceof ApiFailure) return failure(c, error.status, error.code, error.message, error.details);
    if (error instanceof z.ZodError) return failure(c, 422, 'VALIDATION_ERROR', 'Check the submitted fields', error.flatten().fieldErrors);
    if (error instanceof IdempotencyConflict) return failure(c, 409, 'IDEMPOTENCY_CONFLICT', 'Key was already used for different content');
    // postgres/drizzle exceptions can contain SQL and credentials; never serialize them.
    console.error('[film-api] request failed');
    if (isDatabaseFailure(error)) return failure(c, 503, 'DATABASE_UNAVAILABLE', 'Storage is temporarily unavailable');
    return failure(c, 500, 'INTERNAL_ERROR', 'Request failed');
  });
  api.notFound(c=>failure(c,404,'NOT_FOUND','Route not found'));
}
/** Drizzle wraps driver errors in cause; recognize DB/network failures without exposing details. */
function isDatabaseFailure(error: unknown, depth = 0): boolean {
  if (!error || typeof error !== 'object' || depth > 4) return false;
  if ('code' in error && typeof error.code === 'string' && (/^[0-9A-Z]{5}$/.test(error.code) || /^(ECONN|ETIMEDOUT|EPIPE|ENOTFOUND|CONNECTION_|CONNECT_)/.test(error.code))) return true;
  return 'cause' in error && isDatabaseFailure(error.cause, depth + 1);
}

/** Session lookup distinguishes invalid credentials from infrastructure errors. */
export async function requireOperator(c:Context):Promise<string> {
 const operator=await authenticate(getCookie(c,COOKIE));
 if(!operator)throw new ApiFailure(401,'UNAUTHORIZED','Unlock the local workspace');
 return operator;
}
