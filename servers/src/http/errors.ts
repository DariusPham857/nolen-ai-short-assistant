import { randomUUID } from 'node:crypto';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

/** Typed public failure; never return raw exception text to the operator. */
export class ApiFailure extends Error {
  constructor(public status: ContentfulStatusCode, public code: string, message: string, public details?: unknown) { super(message); }
}

/** Stable error envelope shared by middleware, routes and infrastructure failures. */
export function failure(c: Context, status: ContentfulStatusCode, code: string, message: string, details?: unknown) {
  return c.json({ error: { code, message, ...(details === undefined ? {} : { details }), requestId: randomUUID() } }, status);
}
