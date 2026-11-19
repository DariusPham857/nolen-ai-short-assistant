/**
 * Standardized API error envelope.
 *
 * All API responses follow a consistent structure for errors,
 * making it predictable for the frontend to handle.
 *
 * @see PRD §30.7 T-004 shared error schemas
 */
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { ZodError } from "zod";

export interface ApiError {
  error: string;
  message: string;
  details?: unknown;
  requestId?: string;
}

/** Format a Zod validation error into a user-friendly envelope. */
export function zodErrorResponse(c: Context, err: ZodError) {
  return c.json<ApiError>(
    {
      error: "Validation Error",
      message: "Request validation failed",
      details: err.flatten().fieldErrors,
    },
    400,
  );
}

/** Create a typed error response. */
export function errorResponse(
  c: Context,
  status: 400 | 401 | 403 | 404 | 409 | 422 | 500 | 503,
  message: string,
  details?: unknown,
) {
  const statusMessages: Record<number, string> = {
    400: "Bad Request",
    401: "Unauthorized",
    403: "Forbidden",
    404: "Not Found",
    409: "Conflict",
    422: "Unprocessable Entity",
    500: "Internal Server Error",
    503: "Service Unavailable",
  };

  return c.json<ApiError>(
    {
      error: statusMessages[status] ?? "Error",
      message,
      details,
    },
    status,
  );
}
