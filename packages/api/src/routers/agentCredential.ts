import express from 'express';
import mongoose from 'mongoose';

import {
  ensureAgentCredential,
  findAgentInstallationByCredential,
} from '@/controllers/agentInstallation';
import { getRecentInvestigations } from '@/controllers/alertHistory';
import { getAllTeams } from '@/controllers/team';
import { findUserByAccessKey } from '@/controllers/user';
import AgentMemory from '@/models/agentMemory';
import Alert from '@/models/alert';
import AlertHistory from '@/models/alertHistory';
import Team from '@/models/team';
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

  // Validates a credential presented to the agent's conversational route.
  // Callers authenticate with the installation credential; the candidate in
  // the body may be that same credential or a user's personal API access key
  // from the installation's own team. This keeps "who may chat with the
  // investigator" resolvable by the sidecar, which has no database access.
  app.post('/agent/validate-credential', async (req, res, next) => {
    try {
      const key = req.headers.authorization?.split('Bearer ')[1];
      if (!key) {
        return res.sendStatus(401);
      }
      const installation = await findAgentInstallationByCredential(key);
      if (!installation) {
        return res.sendStatus(401);
      }

      const candidate = req.body?.credential;
      if (typeof candidate !== 'string' || candidate.length === 0) {
        return res.status(400).json({ error: 'credential: string required' });
      }

      if (candidate === key) {
        return res.json({ kind: 'agent' });
      }

      const user = await findUserByAccessKey(candidate);
      if (
        user?.team == null ||
        user.team.toString() !== installation.team.toString()
      ) {
        return res.sendStatus(401);
      }
      return res.json({ kind: 'user' });
    } catch (e) {
      next(e);
    }
  });

  // Lists recent completed investigations so the agent can materialize them
  // into its sandbox filesystem (grep-able context for recurring alerts).
  app.get('/agent/investigations', async (req, res, next) => {
    try {
      const key = req.headers.authorization?.split('Bearer ')[1];
      if (!key) {
        return res.sendStatus(401);
      }
      const installation = await findAgentInstallationByCredential(key);
      if (!installation) {
        return res.sendStatus(401);
      }
      const data = await getRecentInvestigations(
        installation.team.toString(),
        50,
      );
      const memories = await AgentMemory.find({ team: installation.team })
        .select('slug content')
        .limit(20);
      const team = await Team.findById(installation.team).select(
        'agentInstructions',
      );
      return res.json({
        data,
        memories: memories.map(m => ({ slug: m.slug, content: m.content })),
        instructions: team?.agentInstructions ?? '',
      });
    } catch (e) {
      next(e);
    }
  });

  // Syncs the agent's memory/ directory after a run. Hard caps keep
  // telemetry-derived text from becoming unbounded durable context, and the
  // credential -> team resolution keeps memories tenant-scoped.
  app.post('/agent/memory', async (req, res, next) => {
    try {
      const key = req.headers.authorization?.split('Bearer ')[1];
      if (!key) {
        return res.sendStatus(401);
      }
      const installation = await findAgentInstallationByCredential(key);
      if (!installation) {
        return res.sendStatus(401);
      }

      const { memories } = req.body ?? {};
      if (!Array.isArray(memories) || memories.length > 10) {
        return res.status(400).json({ error: 'memories: array of at most 10' });
      }
      for (const m of memories) {
        if (
          typeof m?.slug !== 'string' ||
          !/^[a-z0-9][a-z0-9-]{0,59}$/.test(m.slug) ||
          typeof m?.content !== 'string' ||
          m.content.length === 0 ||
          m.content.length > 4096
        ) {
          return res.status(400).json({
            error:
              'each memory needs a kebab-case slug and content <= 4096 chars',
          });
        }
      }

      for (const m of memories) {
        await AgentMemory.findOneAndUpdate(
          { team: installation.team, slug: m.slug },
          { $set: { content: m.content } },
          { upsert: true },
        );
      }
      return res.sendStatus(204);
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

      const { alertHistoryId, alertId, summary, gist } = req.body ?? {};
      if (
        typeof alertHistoryId !== 'string' ||
        typeof alertId !== 'string' ||
        typeof summary !== 'string' ||
        typeof gist !== 'string'
      ) {
        return res.status(400).json({
          error: 'alertHistoryId, alertId, summary, and gist are required',
        });
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
            'investigation.gist': gist,
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
