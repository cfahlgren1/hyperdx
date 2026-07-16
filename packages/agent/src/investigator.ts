import { defineAgent } from '@flue/runtime';

import { clickstackTools } from './mcp.js';

const DEFAULT_MODEL = 'claude-sonnet-5';

// Shared read-only posture used by both the interactive chat agent
// (agents/assistant.ts) and the alert investigation workflow
// (workflows/investigateAlert.ts), so there is one source of truth.
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

export const investigatorAgent = defineAgent(() => ({
  instructions,
  model: getModel(),
  tools: clickstackTools,
}));
