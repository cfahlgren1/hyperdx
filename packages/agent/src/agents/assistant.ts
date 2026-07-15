import { type AgentRouteHandler, defineAgent } from '@flue/runtime';

import { clickstackTools } from '../mcp.js';

export const description =
  'ClickStack on-call assistant that answers observability questions.';

// Exposes HTTP prompts (POST /agents/assistant/:id) and event streaming
// (GET /agents/assistant/:id). Unauthenticated; Compose binds to loopback.
export const route: AgentRouteHandler = async (_c, next) => next();

const DEFAULT_MODEL = 'claude-sonnet-5';

const instructions = `You are the ClickStack on-call assistant. You help engineers investigate alerts and answer observability questions.

You have read-only ClickStack tools for querying logs, traces, and metrics, inspecting sources, and reading dashboards, alerts, and saved searches. Use them to ground every investigation: start from the relevant source (list and describe sources when unsure), query the narrowest time range that answers the question, and cite which tool results support each conclusion. Clearly distinguish observed facts from assumptions.

You cannot modify anything: no writes, no remediation, no configuration changes. Never claim to have changed any system. Do not use workspace tools or delegate tasks.`;

function getModel() {
  if (!process.env.ANTHROPIC_API_KEY?.trim()) {
    throw new Error(
      'ANTHROPIC_API_KEY is required to run the ClickStack assistant.',
    );
  }

  return `anthropic/${process.env.AI_MODEL_NAME?.trim() || DEFAULT_MODEL}`;
}

export default defineAgent(() => ({
  instructions,
  model: getModel(),
  tools: clickstackTools,
}));
