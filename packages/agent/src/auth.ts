import type { AgentRouteHandler } from '@flue/runtime';

import { clickstackCredential } from './mcp.js';

/**
 * Restrict paid agent entrypoints to callers holding the provisioned,
 * installation-scoped ClickStack agent credential.
 */
export const requireAgentCredential: AgentRouteHandler = async (c, next) => {
  const authorization = c.req.header('authorization');
  if (authorization !== `Bearer ${clickstackCredential}`) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  return next();
};
