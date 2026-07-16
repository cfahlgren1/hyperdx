import { Connection } from '@hyperdx/common-utils/dist/types';
import type { NextFunction, Request, Response } from 'express';
import { serializeError } from 'serialize-error';

import * as config from '@/config';
import { findAgentInstallationByCredential } from '@/controllers/agentInstallation';
import { findUserByAccessKey } from '@/controllers/user';
import type { McpContext } from '@/mcp/tools/types';
import { AGENT_CREDENTIAL_PREFIX } from '@/models/agentInstallation';
import type { UserDocument } from '@/models/user';
import {
  getStaticFeatureFlags,
  setBusinessContext,
} from '@/utils/instrumentation';
import logger from '@/utils/logger';

declare global {
  namespace Express {
    interface User extends UserDocument {}
  }
  namespace Express {
    interface Request {
      _hdx_connection?: Connection;
      mcpContext?: McpContext;
    }
  }
}

declare module 'express-session' {
  interface Session {
    messages: string[]; // Set by passport
    passport: { user: string }; // Set by passport
  }
}

export function redirectToDashboard(req: Request, res: Response) {
  // Use 303 See Other so browsers always follow the redirect with GET, even
  // when the original request was a POST (e.g. /login/password). Without an
  // explicit status, Express sends 302 and some browsers/proxies preserve the
  // POST method, which produces a 405 on Next.js pages that only accept GET.
  // The destination is the app root so client-side routing in LandingPage
  // decides where to send the user (/search if logged in, /login otherwise).
  // This avoids hard-coding /search here, which fails when the post-login
  // host differs from the configured FRONTEND_URL (e.g. Vercel previews).
  if (req?.user?.team) {
    return res.redirect(303, `${config.FRONTEND_REDIRECT_BASE}/`);
  } else {
    logger.error(
      { userId: req?.user?._id },
      'Password login for user failed, user or team not found',
    );
    res.redirect(303, `${config.FRONTEND_REDIRECT_BASE}/login?err=unknown`);
  }
}

export function handleAuthError(
  err: any,
  req: Request,
  res: Response,
  next: NextFunction,
) {
  logger.debug({ authErr: serializeError(err) }, 'Auth error');
  if (res.headersSent) {
    return next(err);
  }

  // Get the latest auth error message
  const lastMessage = req.session.messages?.at(-1);
  logger.debug(`Auth error last message: ${lastMessage}`);

  const returnErr =
    lastMessage === 'Password or username is incorrect'
      ? 'authFail'
      : lastMessage ===
          'Authentication method password is not allowed by your team admin.'
        ? 'passwordAuthNotAllowed'
        : 'unknown';

  // 303 forces GET on the redirected request even when the original request
  // was a POST (e.g. /login/password failure path).
  res.redirect(303, `${config.FRONTEND_REDIRECT_BASE}/login?err=${returnErr}`);
}

export async function validateUserAccessKey(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.sendStatus(401);
  }
  const key = authHeader.split('Bearer ')[1];
  if (!key) {
    return res.sendStatus(401);
  }

  const user = await findUserByAccessKey(key);
  if (!user) {
    return res.sendStatus(401);
  }

  req.user = user;

  // Attribute access-key authenticated requests (external API v2 + MCP HTTP)
  // with team/user context so their traces are searchable during incidents.
  setBusinessContext({
    teamId: user.team?.toString(),
    userId: user._id?.toString(),
    email: user.email,
    ...getStaticFeatureFlags(),
  });

  next();
}

/**
 * Authenticates MCP callers. Two credential types, dispatched by prefix:
 *
 * - `hdx_agent_…` — the on-call agent's read-only installation credential.
 *   Resolves to a read-only agent principal and never sets `req.user`, so the
 *   credential is useless against session or External API v2 routes.
 * - anything else — a personal API access key, preserving existing MCP
 *   behavior with a full-access user principal.
 */
export async function validateMcpCredential(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const key = req.headers.authorization?.split('Bearer ')[1];
    if (!key) {
      return res.sendStatus(401);
    }

    if (key.startsWith(AGENT_CREDENTIAL_PREFIX)) {
      const installation = await findAgentInstallationByCredential(key);
      if (!installation) {
        return res.sendStatus(401);
      }
      if (!installation.team) {
        return res.sendStatus(403);
      }

      req.mcpContext = {
        teamId: installation.team.toString(),
        access: 'read',
        principal: { kind: 'agent', id: installation._id.toString() },
      };

      setBusinessContext({
        teamId: req.mcpContext.teamId,
        ...getStaticFeatureFlags(),
      });

      return next();
    }

    const user = await findUserByAccessKey(key);
    if (!user) {
      return res.sendStatus(401);
    }
    if (!user.team) {
      return res.sendStatus(403);
    }

    req.mcpContext = {
      teamId: user.team.toString(),
      access: 'full',
      principal: { kind: 'user', id: user._id.toString() },
    };

    setBusinessContext({
      teamId: req.mcpContext.teamId,
      userId: user._id?.toString(),
      email: user.email,
      ...getStaticFeatureFlags(),
    });

    return next();
  } catch (e) {
    return next(e);
  }
}

export function isUserAuthenticated(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  if (config.IS_LOCAL_APP_MODE) {
    // If local app mode is enabled, skip authentication
    logger.warn('Skipping authentication in local app mode');
    req.user = {
      // @ts-ignore
      _id: '_local_user_',
      email: 'local-user@hyperdx.io',
      // @ts-ignore
      team: '_local_team_',
    };
    setBusinessContext({
      teamId: '_local_team_',
      userId: '_local_user_',
      'hyperdx.local_mode': true,
      ...getStaticFeatureFlags(),
    });
    return next();
  }

  if (req.isAuthenticated()) {
    // Attach incident-remediation context to the trace and active span.
    setBusinessContext({
      teamId: req.user?.team?.toString(),
      userId: req.user?._id?.toString(),
      email: req.user?.email,
      ...getStaticFeatureFlags(),
    });

    return next();
  }
  res.sendStatus(401);
}

export function getNonNullUserWithTeam(req: Request) {
  const user = req.user;

  if (!user) {
    throw new Error('User is not authenticated');
  }

  if (!user.team) {
    throw new Error(`User ${user._id} is not associated with a team`);
  }

  return { teamId: user.team, userId: user._id, email: user.email };
}
