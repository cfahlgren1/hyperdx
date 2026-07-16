import express from 'express';

import { ensureAgentCredential } from '@/controllers/agentInstallation';
import { getAllTeams } from '@/controllers/team';
import logger from '@/utils/logger';

// Required on every provisioning request. This is not a secret — it defends
// against SSRF: a server-side request forged through a URL-fetch feature
// (webhook destinations, connection hosts) can only issue a plain GET and
// cannot set a custom header, so it can never reach this endpoint. See the
// IMDSv2 design (AWS EC2 metadata) for the same pattern.
const AGENT_PROVISION_HEADER = 'x-hyperdx-agent-provision';

/**
 * Serves the on-call agent's read-only MCP credential. Intentionally
 * unauthenticated, so it must only ever listen on a network the deployment
 * trusts: it runs as its own listener on AGENT_CREDENTIAL_PORT, which the
 * Compose file deliberately never publishes to the host. The provisioning
 * header is a second layer that neutralizes SSRF even within that network.
 */
export function createAgentCredentialApp() {
  const app = express();
  app.disable('x-powered-by');

  app.get('/agent/credential', async (req, res, next) => {
    try {
      if (!req.headers[AGENT_PROVISION_HEADER]) {
        return res.sendStatus(403);
      }

      const [team] = await getAllTeams(['_id']);
      if (team == null) {
        logger.info(
          'Agent credential requested before registration; register a ClickStack account first',
        );
        return res.status(409).json({
          error: 'No team exists yet. Register a ClickStack account first.',
        });
      }

      const credential = await ensureAgentCredential(team._id.toString());
      return res.json({ credential });
    } catch (e) {
      next(e);
    }
  });

  return app;
}
