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

const MAX_MULTIPART_FILE_BYTES = 10 * 1024 * 1024; // 10 MiB
const MAX_MULTIPART_BODY_BYTES = MAX_MULTIPART_FILE_BYTES + 64 * 1024; // 10 MiB + 64 KiB

export interface ParsedReferenceUpload {
  fileBuffer: Buffer;
  label: string;
  sourceNote: string;
  licenseUrl: string | null;
  rightsConfirmed: true;
}

/**
 * Stream-bound multipart upload reader: enforces byte cap before delegating
 * boundary/CRLF/quoting parsing to Web API FormData. Never trusts client MIME/filename.
 */
export async function boundedMultipart(
  request: Request,
  maxBodyBytes = MAX_MULTIPART_BODY_BYTES,
  maxFileBytes = MAX_MULTIPART_FILE_BYTES,
): Promise<ParsedReferenceUpload> {
  const rawContentType = request.headers.get('content-type') ?? '';
  if (rawContentType.split(';')[0].trim().toLowerCase() !== 'multipart/form-data') {
    throw new ApiFailure(415, 'UNSUPPORTED_MEDIA_TYPE', 'Use multipart/form-data');
  }
  const declaredLen = request.headers.get('content-length');
  if (declaredLen !== null) {
    const len = Number(declaredLen);
    if (Number.isFinite(len) && len > maxBodyBytes) {
      throw new ApiFailure(413, 'PAYLOAD_TOO_LARGE', 'Multipart upload exceeds 10 MiB limit');
    }
  }

  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  if (reader) {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      totalBytes += next.value.byteLength;
      if (totalBytes > maxBodyBytes) {
        await reader.cancel();
        throw new ApiFailure(413, 'PAYLOAD_TOO_LARGE', 'Multipart upload exceeds 10 MiB limit');
      }
      chunks.push(next.value);
    }
  }

  let form: FormData;
  try {
    const boundedBuffer = Buffer.concat(chunks);
    const internalReq = new Request('http://127.0.0.1:3000/internal-multipart', {
      method: 'POST',
      headers: { 'content-type': rawContentType },
      body: boundedBuffer,
    });
    form = await internalReq.formData();
  } catch {
    throw new ApiFailure(400, 'INVALID_MULTIPART', 'Malformed multipart/form-data payload');
  }

  const fileEntries = form.getAll('file');
  if (fileEntries.length !== 1 || !(fileEntries[0] instanceof File)) {
    throw new ApiFailure(422, 'VALIDATION_ERROR', 'Exactly one reference image file is required');
  }
  // Reject unexpected extra file fields
  for (const [fieldName, value] of form.entries()) {
    if (fieldName !== 'file' && value instanceof File) {
      throw new ApiFailure(422, 'VALIDATION_ERROR', 'Only a single file field is permitted');
    }
  }
  const uploadedFile = fileEntries[0];
  if (uploadedFile.size === 0) {
    throw new ApiFailure(422, 'VALIDATION_ERROR', 'Reference image file cannot be empty');
  }
  if (uploadedFile.size > maxFileBytes) {
    throw new ApiFailure(413, 'PAYLOAD_TOO_LARGE', 'Reference image file exceeds 10 MiB limit');
  }

  const readBoundedText = (field: string, maxLen: number): string => {
    const values = form.getAll(field);
    if (values.length > 1) {
      throw new ApiFailure(422, 'VALIDATION_ERROR', `Duplicate field: ${field}`);
    }
    const raw = values[0];
    if (typeof raw !== 'string') return '';
    if (raw.length > maxLen * 2) {
      throw new ApiFailure(422, 'VALIDATION_ERROR', `${field} exceeds maximum length`);
    }
    return raw.trim();
  };

  const label = readBoundedText('label', 120);
  const sourceNote = readBoundedText('sourceNote', 500);
  const licenseRaw = readBoundedText('licenseUrl', 1000);
  const rightsRaw = readBoundedText('rightsConfirmed', 16);

  if (rightsRaw !== 'true') {
    throw new ApiFailure(422, 'RIGHTS_CONFIRMATION_REQUIRED', 'Producer must confirm commercial/reference usage rights');
  }
  if (!label || label.length > 120) {
    throw new ApiFailure(422, 'VALIDATION_ERROR', 'Label must be 1–120 characters');
  }
  if (!sourceNote || sourceNote.length > 500) {
    throw new ApiFailure(422, 'VALIDATION_ERROR', 'Source note must be 1–500 characters');
  }

  let licenseUrl: string | null = null;
  if (licenseRaw.length > 0) {
    if (licenseRaw.length > 1000) {
      throw new ApiFailure(422, 'VALIDATION_ERROR', 'License URL exceeds 1000 characters');
    }
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(licenseRaw);
    } catch {
      throw new ApiFailure(422, 'VALIDATION_ERROR', 'Invalid licenseUrl');
    }
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      throw new ApiFailure(422, 'VALIDATION_ERROR', 'License URL must use http or https');
    }
    licenseUrl = parsedUrl.toString();
  }

  const fileBuffer = Buffer.from(await uploadedFile.arrayBuffer());
  if (fileBuffer.byteLength === 0 || fileBuffer.byteLength > maxFileBytes) {
    throw new ApiFailure(413, 'PAYLOAD_TOO_LARGE', 'Reference image file exceeds 10 MiB limit');
  }

  return {
    fileBuffer,
    label,
    sourceNote,
    licenseUrl,
    rightsConfirmed: true,
  };
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
