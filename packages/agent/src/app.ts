import { registerProvider } from '@flue/runtime';
import { flue } from '@flue/runtime/routing';
import { Hono } from 'hono';

if (process.env.ANTHROPIC_BASE_URL) {
  registerProvider('anthropic', {
    baseUrl: process.env.ANTHROPIC_BASE_URL,
    apiKey: process.env.ANTHROPIC_API_KEY,
    // Gateway model ids the local catalog doesn't know would otherwise
    // resolve with zero metadata — and maxTokens 0 becomes a 1-token
    // request that truncates or errors. Give them workable limits.
    maxTokens: 32_000,
    contextWindow: 200_000,
  });
}

const app = new Hono();

app.get('/health', c => c.json({ ok: true }));
app.route('/', flue());

export default app;
