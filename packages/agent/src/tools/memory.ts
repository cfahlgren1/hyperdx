import { defineTool } from '@flue/runtime';
import * as v from 'valibot';

import { agentApiUrl } from '../context.js';
import { clickstackCredential } from '../mcp.js';

// Conversations persist durable notes through this tool. Investigations sync
// memory/ file edits in-band after the run instead.
export const updateMemory = defineTool({
  name: 'update_memory',
  description:
    'Persist a durable note about this environment (a memory/<slug>.md file) so future investigations and conversations can read it. Overwrites the slug if it exists. Use sparingly for durable environment facts, not conversation state.',
  input: v.object({
    slug: v.pipe(v.string(), v.regex(/^[a-z0-9][a-z0-9-]{0,59}$/)),
    content: v.pipe(v.string(), v.minLength(1), v.maxLength(4096)),
  }),
  run: async ({ input, signal }) => {
    const response = await fetch(agentApiUrl('memory'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${clickstackCredential}`,
      },
      body: JSON.stringify({
        memories: [{ slug: input.slug, content: input.content }],
      }),
      signal: signal ?? AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      return `Failed to save memory (${response.status}); it will not persist.`;
    }
    return `Saved memory/${input.slug}.md`;
  },
});
