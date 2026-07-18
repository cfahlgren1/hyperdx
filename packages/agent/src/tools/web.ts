import { defineTool } from '@flue/runtime';
import * as v from 'valibot';

const EXA_API_KEY = process.env.EXA_API_KEY ?? '';
const EXA_URL = 'https://api.exa.ai/search';

// Keep tool results small: investigations page over many tool calls, and a
// web result is supporting context, not primary evidence.
const MAX_RESULTS = 5;
const MAX_SNIPPET_CHARS = 1500;

const webSearch = defineTool({
  name: 'web_search',
  description:
    'Search the public web (via Exa) for supporting context: known issues in an implicated software version, error-message meanings, changelog or advisory lookups. Results are snippets with URLs — cite them as external context, never as observed system state.',
  input: v.object({
    query: v.pipe(v.string(), v.minLength(3), v.maxLength(300)),
  }),
  run: async ({ input }) => {
    const response = await fetch(EXA_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': EXA_API_KEY,
      },
      body: JSON.stringify({
        query: input.query,
        numResults: MAX_RESULTS,
        contents: { text: { maxCharacters: MAX_SNIPPET_CHARS } },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      return `Web search failed (${response.status}); continue the investigation without it.`;
    }
    const body = (await response.json()) as {
      results?: { title?: string; url?: string; text?: string }[];
    };
    const results = body.results ?? [];
    if (results.length === 0) {
      return 'No web results found.';
    }
    return results
      .map(
        (r, i) =>
          `[${i + 1}] ${r.title ?? 'untitled'}\n${r.url ?? ''}\n${r.text ?? ''}`,
      )
      .join('\n\n');
  },
});

/** Empty when EXA_API_KEY is unset, so the tool is simply never offered. */
export const webTools = EXA_API_KEY ? [webSearch] : [];
