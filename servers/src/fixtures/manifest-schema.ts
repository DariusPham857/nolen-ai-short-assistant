import { z } from 'zod';
import { providerKindSchema, attemptKindSchema } from '@nolen/contracts';

export const fixtureEntrySchema = z.object({
  fixtureId: z.string().regex(/^[a-z0-9_-]+$/).min(1).max(128),
  provider: providerKindSchema,
  kind: attemptKindSchema,
  aspectRatio: z.enum(['9:16', '16:9']),
  relPath: z.string().regex(/^[a-zA-Z0-9_\-\/]+\.(png|jpg|mp4)$/, { message: 'Path cannot contain traversal or invalid characters' }).refine(
    p => !p.includes('..') && !p.startsWith('/') && !p.includes('\\'),
    { message: 'Path must be relative and cannot contain traversal or backslashes' }
  ),
  mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'video/mp4']),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  byteSize: z.number().int().positive(),
}).strict();

export type FixtureEntry = z.infer<typeof fixtureEntrySchema>;

export const fixtureManifestSchema = z.object({
  version: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
  fixtures: z.array(fixtureEntrySchema).min(1).refine(
    fixtures => new Set(fixtures.map(f => f.fixtureId)).size === fixtures.length,
    { message: 'Duplicate fixtureId in manifest' }
  ),
}).strict();

export type FixtureManifest = z.infer<typeof fixtureManifestSchema>;
