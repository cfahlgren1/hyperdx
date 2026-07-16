import { type AgentRouteHandler } from '@flue/runtime';

import { investigatorAgent } from '../investigator.js';

export const description =
  'ClickStack on-call assistant that answers observability questions.';

// Exposes HTTP prompts (POST /agents/assistant/:id) and event streaming
// (GET /agents/assistant/:id). Unauthenticated; Compose binds to loopback.
export const route: AgentRouteHandler = async (_c, next) => next();

export default investigatorAgent;
