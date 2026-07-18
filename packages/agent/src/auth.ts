import type { AgentRouteHandler } from '@flue/runtime';

import { agentApiUrl } from './context.js';
import { clickstackCredential } from './mcp.js';

// Validated personal keys are cached briefly to avoid per-request round trips.
const VALIDATED_TTL_MS = 60_000;
const VALIDATED_MAX = 100;
const validatedUntil = new Map<string, number>();

async function isValidUserCredential(candidate: string): Promise<boolean> {
  const cached = validatedUntil.get(candidate);
  if (cached !== undefined && cached > Date.now()) {
    return true;
  }
  try {
    const response = await fetch(agentApiUrl('validate-credential'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${clickstackCredential}`,
      },
      body: JSON.stringify({ credential: candidate }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      return false;
    }
    if (validatedUntil.size >= VALIDATED_MAX) {
      validatedUntil.clear();
    }
    validatedUntil.set(candidate, Date.now() + VALIDATED_TTL_MS);
    return true;
  } catch {
    // Fail closed when the platform is unreachable.
    return false;
  }
}

/** Gate workflow entrypoints behind exactly the installation credential. */
export const requireInstallationCredential: AgentRouteHandler = async (
  c,
  next,
) => {
  const authorization = c.req.header('authorization');
  if (authorization !== `Bearer ${clickstackCredential}`) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  return next();
};

/**
 * Gate conversational entrypoints behind the installation credential or a
 * personal API key from the same team (validated against the ClickStack API).
 */
export const requireAgentCredential: AgentRouteHandler = async (c, next) => {
  const authorization = c.req.header('authorization');
  const candidate = authorization?.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length)
    : undefined;
  if (!candidate) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  if (candidate === clickstackCredential) {
    return next();
  }
  if (await isValidUserCredential(candidate)) {
    return next();
  }
  return c.json({ error: 'unauthorized' }, 401);
};
