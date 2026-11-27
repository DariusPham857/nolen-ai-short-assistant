import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';

describe('Docker Compose Provider Credential Propagation (PD-05b BLOCK 4)', () => {
  it('propagates GEMINI_API_KEY, RUNWAY_API_KEY, and FAL_API_KEY to both web and worker services without client exposure', async () => {
    const composePath = path.resolve(process.cwd(), '..', 'docker-compose.yml');
    const content = await fs.readFile(composePath, 'utf8');

    // Never expose provider keys as NEXT_PUBLIC_ client vars
    expect(content).not.toMatch(/NEXT_PUBLIC_.*(GEMINI|RUNWAY|FAL)_API_KEY/);

    // Default EXECUTION_MODE remains REPLAY unless explicitly overridden
    expect(content).toContain('EXECUTION_MODE: ${EXECUTION_MODE:-REPLAY}');

    const webMatch = content.match(/\n  web:\r?\n([\s\S]*?)\n  worker:/);
    const workerMatch = content.match(/\n  worker:\r?\n([\s\S]*?)\nvolumes:/);

    expect(webMatch?.[1]).toBeDefined();
    expect(workerMatch?.[1]).toBeDefined();

    for (const key of ['GEMINI_API_KEY', 'RUNWAY_API_KEY', 'FAL_API_KEY']) {
      expect(webMatch![1]).toContain(`${key}: \${${key}:-}`);
      expect(workerMatch![1]).toContain(`${key}: \${${key}:-}`);
    }
  });
});
