import type {
  AlertApiResponse,
  AlertHistoryRangeApiResponse,
  AlertInvestigationsApiResponse,
  AlertsApiResponse,
  AlertsPageItem,
  InvestigationTrajectoryApiResponse,
  InvestigationTrajectoryStep,
} from '@hyperdx/common-utils/dist/types';
import express from 'express';
import { pick } from 'lodash';
import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { processRequest, validateRequest } from 'zod-express-middleware';

import * as config from '@/config';
import { ensureAgentCredential } from '@/controllers/agentInstallation';
import {
  getAlertTransitionsInRange,
  getRecentAlertHistories,
  getRecentAlertHistoriesBatch,
  getRecentInvestigations,
} from '@/controllers/alertHistory';
import {
  createAlert,
  deleteAlert,
  getAlertById,
  getAlertEnhanced,
  getAlertsEnhanced,
  updateAlert,
  validateAlertInput,
} from '@/controllers/alerts';
import Alert from '@/models/alert';
import AlertHistory, { IAlertHistory } from '@/models/alertHistory';
import Team from '@/models/team';
import { PreSerialized, sendJson } from '@/utils/serialization';
import { alertSchema, objectIdSchema } from '@/utils/zod';

const router = express.Router();

type EnhancedAlert = NonNullable<Awaited<ReturnType<typeof getAlertEnhanced>>>;

const formatAlertResponse = (
  alert: EnhancedAlert,
  history: Omit<IAlertHistory, 'alert'>[],
): PreSerialized<AlertsPageItem> => {
  return {
    history,
    silenced: alert.silenced
      ? {
          by: alert.silenced.by?.email,
          at: alert.silenced.at,
          until: alert.silenced.until,
        }
      : undefined,
    createdBy: alert.createdBy
      ? pick(alert.createdBy, ['email', 'name'])
      : undefined,
    channel: pick(alert.channel, ['type']),
    ...(alert.dashboard && {
      dashboardId: alert.dashboard._id,
      dashboard: {
        tiles: alert.dashboard.tiles
          .filter(tile => tile.id === alert.tileId)
          .map(tile => ({
            id: tile.id,
            config: { name: tile.config.name },
          })),
        ...pick(alert.dashboard, ['_id', 'updatedAt', 'name', 'tags']),
      },
    }),
    ...(alert.savedSearch && {
      savedSearchId: alert.savedSearch._id,
      savedSearch: pick(alert.savedSearch, [
        '_id',
        'createdAt',
        'name',
        'updatedAt',
        'tags',
      ]),
    }),
    ...pick(alert, [
      '_id',
      'interval',
      'scheduleOffsetMinutes',
      'scheduleStartAt',
      'threshold',
      'thresholdMax',
      'thresholdType',
      'state',
      'source',
      'tileId',
      'note',
      'createdAt',
      'updatedAt',
      'executionErrors',
      'numConsecutiveWindows',
      'investigationsDisabled',
    ]),
  };
};

type AlertsExpRes = express.Response<AlertsApiResponse>;
router.get('/', async (req, res: AlertsExpRes, next) => {
  try {
    const teamId = req.user?.team;
    if (teamId == null) {
      return res.sendStatus(403);
    }

    const alerts = await getAlertsEnhanced(teamId);

    const historyMap = await getRecentAlertHistoriesBatch(
      alerts.map(alert => ({
        alertId: new ObjectId(alert._id),
        interval: alert.interval,
      })),
      20,
    );

    const data = alerts.map(alert => {
      const history = historyMap.get(alert._id.toString()) ?? [];
      return formatAlertResponse(alert, history);
    });

    sendJson(res, { data });
  } catch (e) {
    next(e);
  }
});

// One page of a flue run's durable event stream.
interface FlueRunEvent {
  type: string;
  timestamp: string;
  toolName?: string;
  toolCallId?: string;
  content?: unknown;
  isError?: boolean;
  result?: { content?: { type: string; text?: string }[] };
  message?: {
    role?: string;
    content?: {
      type: string;
      text?: string;
      id?: string;
      arguments?: unknown;
    }[];
  };
  error?: { message?: string };
  durationMs?: number;
  response?: {
    usage?: {
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
      cost?: { total?: number };
    };
  };
}

function trajectoryUsageFromEvents(events: FlueRunEvent[]) {
  let inputTokens = 0;
  let cachedTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  for (const event of events) {
    const usage = event.type === 'turn' ? event.response?.usage : undefined;
    if (!usage) {
      continue;
    }
    inputTokens += usage.input ?? 0;
    cachedTokens += (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
    outputTokens += usage.output ?? 0;
    costUsd += usage.cost?.total ?? 0;
  }
  return inputTokens + cachedTokens + outputTokens > 0
    ? { inputTokens, cachedTokens, outputTokens, costUsd }
    : undefined;
}

const TRAJECTORY_MAX_PAGES = 40;
const TRAJECTORY_MAX_STEPS = 300;

function compactArgs(args: unknown): string | undefined {
  if (args == null || typeof args !== 'object') {
    return undefined;
  }
  const parts = Object.entries(args as Record<string, unknown>).map(
    ([key, value]) => {
      const rendered =
        typeof value === 'string' ? value : JSON.stringify(value);
      return `${key}=${(rendered ?? '').slice(0, 120)}`;
    },
  );
  const joined = parts.join('  ');
  return joined ? joined.slice(0, 300) : undefined;
}

function trajectoryStepsFromEvents(
  events: FlueRunEvent[],
): InvestigationTrajectoryStep[] {
  // Tool call arguments arrive on the assistant message, keyed by call id.
  const argsByCallId = new Map<string, string>();
  for (const event of events) {
    if (event.type !== 'message_end' || event.message?.role !== 'assistant') {
      continue;
    }
    for (const block of event.message.content ?? []) {
      if (block.type === 'toolCall' && block.id) {
        const compact = compactArgs(block.arguments);
        if (compact) {
          argsByCallId.set(block.id, compact);
        }
      }
    }
  }

  const steps: InvestigationTrajectoryStep[] = [];
  const started = new Map<
    string,
    { step: InvestigationTrajectoryStep; startedAt: number }
  >();
  for (const event of events) {
    if (steps.length >= TRAJECTORY_MAX_STEPS) {
      break;
    }
    if (event.type === 'thinking_end') {
      const text = typeof event.content === 'string' ? event.content : '';
      if (text.trim()) {
        steps.push({
          type: 'thinking',
          timestamp: event.timestamp,
          text: text.slice(0, 2000),
        });
      }
    } else if (event.type === 'tool_start') {
      const step: InvestigationTrajectoryStep = {
        type: 'tool',
        timestamp: event.timestamp,
        // Strip the MCP server prefix for display (mcp__clickstack__x -> x).
        toolName: (event.toolName ?? 'tool').replace(/^mcp__[^_]+__/, ''),
        input: event.toolCallId
          ? argsByCallId.get(event.toolCallId)
          : undefined,
      };
      steps.push(step);
      if (event.toolCallId) {
        started.set(event.toolCallId, {
          step,
          startedAt: new Date(event.timestamp).getTime(),
        });
      }
    } else if (event.type === 'tool') {
      const open = event.toolCallId ? started.get(event.toolCallId) : undefined;
      if (!open) {
        continue;
      }
      open.step.durationMs =
        new Date(event.timestamp).getTime() - open.startedAt;
      open.step.isError = !!event.isError;
      const text = (event.result?.content ?? []).find(
        c => c.type === 'text' && c.text,
      )?.text;
      if (text) {
        open.step.result = text.slice(0, 600);
      }
    }
  }
  return steps;
}

// Registered before '/:id' so the literal prefix wins over the param route.
type TrajectoryExpRes = express.Response<InvestigationTrajectoryApiResponse>;
router.get(
  '/investigations/:historyId/trajectory',
  validateRequest({ params: z.object({ historyId: objectIdSchema }) }),
  async (req, res: TrajectoryExpRes, next) => {
    try {
      const teamId = req.user?.team;
      if (teamId == null) {
        return res.sendStatus(403);
      }
      const history = await AlertHistory.findById(req.params.historyId);
      const runId = history?.investigation?.runId;
      if (!history || !runId) {
        return res.sendStatus(404);
      }
      const owned = await Alert.exists({ _id: history.alert, team: teamId });
      if (!owned) {
        return res.sendStatus(404);
      }

      const credential = await ensureAgentCredential(teamId.toString());
      const base = config.AGENT_WORKFLOW_URL.replace(/\/workflows\/.*$/, '');
      const events: FlueRunEvent[] = [];
      let offset: string | undefined;
      for (let page = 0; page < TRAJECTORY_MAX_PAGES; page++) {
        const url = new URL(`${base}/runs/${runId}`);
        if (offset) {
          url.searchParams.set('offset', offset);
        }
        const upstream = await fetch(url, {
          headers: { authorization: `Bearer ${credential}` },
          signal: AbortSignal.timeout(10_000),
        });
        if (upstream.status === 404) {
          // The agent's run store no longer has this run (e.g. volume reset).
          return res.sendStatus(404);
        }
        if (!upstream.ok) {
          return res.sendStatus(502);
        }
        const batch = (await upstream.json()) as FlueRunEvent[];
        events.push(...batch);
        if (
          batch.length === 0 ||
          batch.some(e => e.type === 'run_end') ||
          events.length >= 5000
        ) {
          break;
        }
        const next = upstream.headers.get('stream-next-offset');
        if (!next || next === offset) {
          break;
        }
        offset = next;
      }

      const runEnd = events.find(e => e.type === 'run_end');
      sendJson(res, {
        status: runEnd ? (runEnd.isError ? 'errored' : 'completed') : 'running',
        usage: trajectoryUsageFromEvents(events),
        data: trajectoryStepsFromEvents(events),
      });
    } catch (e) {
      next(e);
    }
  },
);

// Registered before '/:id' so the literal path wins over the param route.
type InvestigationsExpRes = express.Response<AlertInvestigationsApiResponse>;
router.get('/investigations', async (req, res: InvestigationsExpRes, next) => {
  try {
    const teamId = req.user?.team;
    if (teamId == null) {
      return res.sendStatus(403);
    }

    const team = await Team.findById(teamId).select('investigationsEnabled');
    const enabled =
      config.AGENT_INVESTIGATIONS_ENABLED &&
      team?.investigationsEnabled !== false;
    const data = await getRecentInvestigations(teamId.toString());
    sendJson(res, { enabled, data });
  } catch (e) {
    next(e);
  }
});

type AlertExpRes = express.Response<AlertApiResponse>;
router.get(
  '/:id',
  validateRequest({
    params: z.object({
      id: objectIdSchema,
    }),
  }),
  async (req, res: AlertExpRes, next) => {
    try {
      const teamId = req.user?.team;
      if (teamId == null) {
        return res.sendStatus(403);
      }

      const alert = await getAlertEnhanced(req.params.id, teamId);
      if (!alert) {
        return res.sendStatus(404);
      }

      const history = await getRecentAlertHistories({
        alertId: new ObjectId(alert._id),
        interval: alert.interval,
        limit: 20,
      });

      const data = formatAlertResponse(alert, history);

      sendJson(res, { data });
    } catch (e) {
      next(e);
    }
  },
);

// Alert firing/recovery transitions within a time range, used to draw
// annotations on dashboard charts (startTime/endTime are epoch milliseconds).
// Alert history has a ~30-day TTL, so cap the queried span to bound the
// aggregation regardless of how small a startTime the caller sends.
const MAX_HISTORY_SPAN_MS = 31 * 24 * 60 * 60 * 1000;
type AlertHistoryRangeExpRes = express.Response<AlertHistoryRangeApiResponse>;
router.get(
  '/:id/history',
  processRequest({
    params: z.object({ id: objectIdSchema }),
    query: z
      .object({
        startTime: z.coerce.number().int(),
        endTime: z.coerce.number().int(),
      })
      .refine(q => q.startTime < q.endTime, {
        message: 'startTime must be less than endTime',
      }),
  }),
  async (req, res: AlertHistoryRangeExpRes, next) => {
    try {
      const teamId = req.user?.team;
      if (teamId == null) {
        return res.sendStatus(403);
      }

      // Scope to the caller's team (404 for alerts they can't see). Uses the
      // populate-free lookup since we only need team ownership + interval.
      const alert = await getAlertById(req.params.id, teamId);
      if (!alert) {
        return res.sendStatus(404);
      }

      // Clamp the span so a tiny/zero startTime can't force a scan wider than
      // the history retention window.
      const startTime = Math.max(
        req.query.startTime,
        req.query.endTime - MAX_HISTORY_SPAN_MS,
      );

      const data = await getAlertTransitionsInRange({
        alertId: new ObjectId(alert._id),
        interval: alert.interval,
        startTime: new Date(startTime),
        endTime: new Date(req.query.endTime),
      });

      sendJson(res, { data });
    } catch (e) {
      next(e);
    }
  },
);

router.post(
  '/',
  processRequest({ body: alertSchema }),
  async (req, res, next) => {
    const teamId = req.user?.team;
    const userId = req.user?._id;
    if (teamId == null || userId == null) {
      return res.sendStatus(403);
    }
    try {
      const alertInput = req.body;
      await validateAlertInput(teamId, alertInput);
      return res.json({
        data: await createAlert(teamId, alertInput, userId),
      });
    } catch (e) {
      next(e);
    }
  },
);

router.put(
  '/:id',
  processRequest({
    body: alertSchema,
    params: z.object({
      id: objectIdSchema,
    }),
  }),
  async (req, res, next) => {
    try {
      const teamId = req.user?.team;
      if (teamId == null) {
        return res.sendStatus(403);
      }
      const { id } = req.params;
      const alertInput = req.body;
      await validateAlertInput(teamId, alertInput);
      res.json({
        data: await updateAlert(id, teamId, alertInput),
      });
    } catch (e) {
      next(e);
    }
  },
);

router.post(
  '/:id/silenced',
  validateRequest({
    body: z.object({
      mutedUntil: z
        .string()
        .datetime()
        .refine(val => new Date(val) > new Date(), {
          message: 'mutedUntil must be in the future',
        }),
    }),
    params: z.object({
      id: objectIdSchema,
    }),
  }),
  async (req, res, next) => {
    try {
      const teamId = req.user?.team;
      if (teamId == null || req.user == null) {
        return res.sendStatus(403);
      }

      const alert = await getAlertById(req.params.id, teamId);
      if (!alert) {
        return res.status(404).json({ error: 'Alert not found' });
      }
      alert.silenced = {
        by: req.user._id,
        at: new Date(),
        until: new Date(req.body.mutedUntil),
      };
      await alert.save();

      res.sendStatus(200);
    } catch (e) {
      next(e);
    }
  },
);

router.delete(
  '/:id/silenced',
  validateRequest({
    params: z.object({
      id: objectIdSchema,
    }),
  }),
  async (req, res, next) => {
    try {
      const teamId = req.user?.team;
      if (teamId == null) {
        return res.sendStatus(403);
      }

      const alert = await getAlertById(req.params.id, teamId);
      if (!alert) {
        return res.status(404).json({ error: 'Alert not found' });
      }
      alert.silenced = undefined;
      await alert.save();

      res.sendStatus(200);
    } catch (e) {
      next(e);
    }
  },
);

router.delete(
  '/:id',
  validateRequest({
    params: z.object({
      id: objectIdSchema,
    }),
  }),
  async (req, res, next) => {
    try {
      const teamId = req.user?.team;
      const { id: alertId } = req.params;
      if (teamId == null) {
        return res.sendStatus(403);
      }
      if (!alertId) {
        return res.sendStatus(400);
      }

      await deleteAlert(alertId, teamId);
      res.sendStatus(200);
    } catch (e) {
      next(e);
    }
  },
);

export default router;
