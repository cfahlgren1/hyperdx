import express from 'express';
import mongoose from 'mongoose';

import {
  ensureAgentCredential,
  findAgentInstallationByCredential,
} from '@/controllers/agentInstallation';
import { getAllTeams } from '@/controllers/team';
import Alert from '@/models/alert';
import AlertHistory from '@/models/alertHistory';
import { setBusinessContext } from '@/utils/instrumentation';
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
  app.use(express.json());

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

  // Stores an investigation summary on the AlertHistory doc. Unlike the
  // credential handout above this mutates Mongo, so it requires the agent
  // credential and is scoped to that credential's team.
  app.post('/agent/investigations', async (req, res, next) => {
    try {
      const key = req.headers.authorization?.split('Bearer ')[1];
      if (!key) {
        return res.sendStatus(401);
      }

      const installation = await findAgentInstallationByCredential(key);
      if (!installation) {
        return res.sendStatus(401);
      }
      const teamId = installation.team;

      const { alertHistoryId, alertId, summary } = req.body ?? {};
      if (
        typeof alertHistoryId !== 'string' ||
        typeof alertId !== 'string' ||
        typeof summary !== 'string'
      ) {
        return res
          .status(400)
          .json({ error: 'alertHistoryId, alertId, and summary are required' });
      }
      if (
        !mongoose.isValidObjectId(alertHistoryId) ||
        !mongoose.isValidObjectId(alertId)
      ) {
        return res.sendStatus(404);
      }

      const history =
        await AlertHistory.findById(alertHistoryId).select('alert');
      if (!history) {
        return res.sendStatus(404);
      }

      // A mismatched pair must not graft one alert's findings onto another's
      // record.
      if (history.alert?.toString() !== alertId) {
        return res.sendStatus(409);
      }

      // The credential's team must own the alert before we write.
      const alert = await Alert.findById(history.alert).select('team');
      if (!alert || alert.team?.toString() !== teamId.toString()) {
        return res.sendStatus(403);
      }

      setBusinessContext({ teamId: teamId.toString() });

      // Only marked histories are writable and delivered summaries are
      // immutable; the filter makes the check-and-set atomic.
      const updated = await AlertHistory.findOneAndUpdate(
        {
          _id: history._id,
          'investigation.requestedAt': { $exists: true },
          'investigation.summary': { $exists: false },
        },
        {
          $set: {
            'investigation.summary': summary,
            'investigation.completedAt': new Date(),
          },
        },
      );
      if (!updated) {
        return res.sendStatus(409);
      }

      return res.sendStatus(204);
    } catch (e) {
      next(e);
    }
  });

  return app;
}
