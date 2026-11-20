import { apiErrorSchema } from '@nolen/contracts';

/** Read only the agreed safe envelope; network/unknown response remains uncertain. */
export async function errorMessage(response: Response): Promise<string> {
  const body: unknown = await response.json().catch(() => null);
  const parsed = apiErrorSchema.safeParse(body);
  return parsed.success ? parsed.data.error.message : 'Request could not be confirmed. Try again.';
}
