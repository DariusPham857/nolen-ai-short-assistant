import { createHash } from 'node:crypto';

export const APP_ORIGIN = 'http://127.0.0.1:3000';
export const OPERATOR_ID = 'local-operator';

/** Validate at web startup, not during next build. Never expose credentials in errors. */
export function runtimeConfig() {
  const token = process.env.OPERATOR_TOKEN;
  const databaseUrl = process.env.DATABASE_URL;
  if (!token || Buffer.byteLength(token) < 32) throw new Error('OPERATOR_TOKEN must have at least 32 bytes');
  if (!databaseUrl || !/^postgres(ql)?:\/\//.test(databaseUrl)) throw new Error('DATABASE_URL is required');
  return { token, fingerprint: createHash('sha256').update(token).digest('hex') };
}
