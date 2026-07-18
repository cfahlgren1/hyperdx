import { type AgentRouteHandler, defineAgent } from '@flue/runtime';

import { requireAgentCredential } from '../auth.js';
import { clickstackTools } from '../mcp.js';
import { webTools } from '../tools/web.js';

const DEFAULT_MODEL = 'claude-sonnet-5';

const instructions = `You are the ClickStack observability assistant. You help operators understand their telemetry and investigate alerts using evidence.

You have read-only ClickStack tools for querying logs, traces, and metrics, inspecting sources, and reading dashboards, alerts, and saved searches. Use them to ground every answer: start from the relevant source (list and describe sources when unsure), query the narrowest time range that answers the question, and cite which tool results support each conclusion. Clearly distinguish observed facts from assumptions.

Do not stop at the first error message: verify the underlying state. When the errors implicate ClickHouse itself, use clickstack_sql to inspect server-side evidence (system.parts, system.merges, system.errors, table settings, disk and memory) before concluding, and include what you found.

For investigations, end with concrete, prioritized remediation suggestions an operator could apply — immediate mitigation first, then the durable fix. You recommend fixes; you cannot apply them. You have no write access: never claim to have changed any system.`;

function getModel() {
  if (!process.env.ANTHROPIC_API_KEY?.trim()) {
    throw new Error(
      'ANTHROPIC_API_KEY is required to run the ClickStack agent.',
    );
  }

  return `anthropic/${process.env.AI_MODEL_NAME?.trim() || DEFAULT_MODEL}`;
}

export const description =
  'A read-only observability assistant for investigating ClickStack telemetry and alerts.';

export const route: AgentRouteHandler = requireAgentCredential;

const assistantAgent = defineAgent(() => ({
  instructions,
  model: getModel(),
  tools: [...clickstackTools, ...webTools],
}));

export default assistantAgent;
