import PQueue from '@esm2cjs/p-queue';
import { ClickhouseClient } from '@hyperdx/common-utils/dist/clickhouse/node';
import { displayTypeSupportsRawSqlAlerts } from '@hyperdx/common-utils/dist/core/utils';
import { isRawSqlSavedChartConfig } from '@hyperdx/common-utils/dist/guards';
import { Tile } from '@hyperdx/common-utils/dist/types';
import mongoose from 'mongoose';
import ms from 'ms';
import { URLSearchParams } from 'url';

import * as config from '@/config';
import { ensureAgentCredential } from '@/controllers/agentInstallation';
import { ALERT_HISTORY_QUERY_CONCURRENCY } from '@/controllers/alertHistory';
import { getAllTeams } from '@/controllers/team';
import { LOCAL_APP_TEAM } from '@/controllers/team';
import { connectDB, mongooseConnection, ObjectId } from '@/models';
import Alert, {
  AlertSource,
  AlertState,
  type IAlert,
  type IAlertError,
} from '@/models/alert';
import AlertHistory, { IAlertHistory } from '@/models/alertHistory';
import Connection, { IConnection } from '@/models/connection';
import Dashboard from '@/models/dashboard';
import { type ISavedSearch, SavedSearch } from '@/models/savedSearch';
import { type ISource, Source } from '@/models/source';
import Team from '@/models/team';
import Webhook, { IWebhook } from '@/models/webhook';
import {
  AggregatedAlertHistory,
  getConsecutiveWindowHistories,
  getPreviousAlertHistories,
} from '@/tasks/checkAlerts';
import {
  type AlertDetails,
  type AlertProvider,
  type AlertTask,
  AlertTaskType,
} from '@/tasks/checkAlerts/providers';
import { MappedOmit } from '@/tasks/types';
import { convertMsToGranularityString } from '@/utils/common';
import { getCounter } from '@/utils/instrumentation';
import logger from '@/utils/logger';

type PartialAlertDetails = MappedOmit<AlertDetails, 'previousMap'>;

const alertInvestigationDispatchCounter = getCounter(
  'hyperdx.alerts.investigation_dispatches',
  {
    description:
      'Count of agent investigation dispatches on a fresh alert fire, labeled by outcome (dispatched, failed, ambiguous, cooldown, budget, disabled, or skipped_team).',
  },
);

// Bounds LLM spend when a grouped alert's groups all breach on the same tick
// (group cardinality is telemetry-controlled, so it can be externally inflated).
const MAX_INVESTIGATION_DISPATCHES_PER_EVALUATION = 5;

// Bounds each workflow dispatch so a stalled agent endpoint cannot accumulate
// sockets across evaluations.
const INVESTIGATION_DISPATCH_TIMEOUT_MS = 10_000;

// At most one investigation per alert per window, so a flapping alert
// (which crosses the fire edge on every flap) can't burn tokens.
const INVESTIGATION_COOLDOWN_MS = 60 * 60 * 1000;

// Global per-task-run budget, so a broad outage firing many alerts in one
// sweep cannot fan out into unbounded concurrent LLM runs.
const MAX_INVESTIGATION_DISPATCHES_PER_RUN = 10;

// Remove markers from suppressed fires, so a marker only ever means "an
// investigation was actually requested from the agent". Best-effort.
async function clearInvestigationMarkers(
  ids: mongoose.Types.ObjectId[],
): Promise<void> {
  try {
    await AlertHistory.updateMany(
      { _id: { $in: ids } },
      { $unset: { investigation: '' } },
    );
  } catch (error) {
    logger.warn(
      { ids: ids.map(String), error: String(error) },
      'Failed to clear suppressed investigation markers',
    );
  }
}

async function getSavedSearchDetails(
  alert: IAlert,
): Promise<[IConnection, PartialAlertDetails] | []> {
  const savedSearchId = alert.savedSearch;
  const savedSearch = await SavedSearch.findOne({
    _id: savedSearchId,
    team: alert.team,
  }).populate<Omit<ISavedSearch, 'source'> & { source: ISource }>({
    path: 'source',
    match: { team: alert.team },
  });

  if (!savedSearch) {
    logger.error({
      message: 'savedSearch not found',
      savedSearchId,
      alertId: alert.id,
    });
    return [];
  }

  const { source } = savedSearch;
  const connId = source.connection;
  const conn = await Connection.findOne({
    _id: connId,
    team: alert.team,
  }).select('+password');
  if (!conn) {
    logger.error({
      message: 'connection not found',
      alertId: alert.id,
      connId,
      savedSearchId,
    });
    return [];
  }

  return [
    conn,
    {
      alert,
      source,
      taskType: AlertTaskType.SAVED_SEARCH,
      savedSearch,
    },
  ];
}

async function getTileDetails(
  alert: IAlert,
): Promise<[IConnection, PartialAlertDetails] | []> {
  const dashboardId = alert.dashboard;
  const tileId = alert.tileId;

  const dashboard = await Dashboard.findOne({
    _id: dashboardId,
    team: alert.team,
  });
  if (!dashboard) {
    logger.error({
      message: 'dashboard not found',
      dashboardId,
      alertId: alert.id,
    });
    return [];
  }

  const tile = dashboard.tiles?.find((t: Tile) => t.id === tileId);
  if (!tile) {
    logger.error({
      message: 'tile matching alert not found',
      tileId,
      dashboardId: dashboard._id,
      alertId: alert.id,
    });
    return [];
  }

  if (isRawSqlSavedChartConfig(tile.config)) {
    if (!displayTypeSupportsRawSqlAlerts(tile.config.displayType)) {
      logger.warn({
        tileId,
        dashboardId: dashboard._id,
        alertId: alert.id,
        message:
          'skipping alert with raw sql chart config, only line/bar display types are supported',
      });
      return [];
    }

    // Raw SQL tiles store connection ID directly on the config
    const connection = await Connection.findOne({
      _id: tile.config.connection,
      team: alert.team,
    }).select('+password');

    if (!connection) {
      logger.error({
        message: 'connection not found for raw sql tile',
        connectionId: tile.config.connection,
        tileId,
        dashboardId: dashboard._id,
        alertId: alert.id,
      });
      return [];
    }

    // Optionally look up source for filter/macro metadata
    let source: ISource | undefined;
    if (tile.config.source) {
      const sourceDoc = await Source.findOne({
        _id: tile.config.source,
        team: alert.team,
      });
      if (sourceDoc) {
        source = sourceDoc.toObject();
      }
    }

    return [
      connection,
      {
        alert,
        source,
        taskType: AlertTaskType.TILE,
        tile,
        dashboard,
      },
    ];
  }

  const source = await Source.findOne({
    _id: tile.config.source,
    team: alert.team,
  }).populate<Omit<ISource, 'connection'> & { connection: IConnection }>({
    path: 'connection',
    match: { team: alert.team },
    select: '+password',
  });
  if (!source) {
    logger.error({
      message: 'source not found',
      sourceId: tile.config.source,
      tileId,
      dashboardId: dashboard._id,
      alertId: alert.id,
    });
    return [];
  }

  if (!source.connection) {
    logger.error({
      message: 'connection not found',
      alertId: alert.id,
      tileId,
      dashboardId: dashboard._id,
      sourceId: source.id,
    });
    return [];
  }

  const connection = source.connection;
  const sourceProps = source.toObject();
  return [
    connection,
    {
      alert,
      source: { ...sourceProps, connection: connection.id },
      taskType: AlertTaskType.TILE,
      tile,
      dashboard,
    },
  ];
}

async function loadAlert(
  alert: IAlert,
  groupedTasks: Map<string, AlertTask>,
  previousAlerts: Map<string, AggregatedAlertHistory>,
  recentHistoryMap: Map<string, AggregatedAlertHistory[]>,
  now: Date,
) {
  if (!alert.source) {
    throw new Error('alert does not have a source');
  }

  if (config.IS_LOCAL_APP_MODE) {
    // The id is the 12 character string `_local_team_', which will become an ObjectId
    // as the ASCII hex values, so 5f6c6f63616c5f7465616d5f.
    alert.team = new mongoose.Types.ObjectId(LOCAL_APP_TEAM.id);
  }

  let conn: IConnection | undefined;
  let details: PartialAlertDetails | undefined;
  switch (alert.source) {
    case AlertSource.SAVED_SEARCH:
      [conn, details] = await getSavedSearchDetails(alert);
      break;

    case AlertSource.TILE:
      [conn, details] = await getTileDetails(alert);
      break;

    default:
      throw new Error(`unsupported source: ${alert.source}`);
  }

  if (!details) {
    throw new Error('failed to fetch alert details');
  }

  if (!conn) {
    throw new Error('failed to fetch alert connection');
  }

  if (!groupedTasks.has(conn.id)) {
    groupedTasks.set(conn.id, { alerts: [], conn, now });
  }
  const v = groupedTasks.get(conn.id);
  if (!v) {
    throw new Error(`provider did not set key ${conn.id} before appending`);
  }
  v.alerts.push({
    ...details,
    previousMap: previousAlerts,
    recentHistoryMap,
  });
}

export default class DefaultAlertProvider implements AlertProvider {
  // Remaining global dispatch budget for this task run (see
  // MAX_INVESTIGATION_DISPATCHES_PER_RUN).
  private investigationBudget = MAX_INVESTIGATION_DISPATCHES_PER_RUN;

  // The team whose credential the agent holds (the first team). Cached on
  // first dispatch; null when no team exists.
  private installationTeamId: string | null | undefined = undefined;

  async init() {
    await Promise.all([connectDB()]);
  }

  async asyncDispose() {
    await mongooseConnection.close();
  }

  async getAlertTasks(): Promise<AlertTask[]> {
    const groupedTasks = new Map<string, AlertTask>();
    const alerts = await Alert.find({});

    const now = new Date();
    const alertIds = alerts.map(({ id }) => id);
    // Share a single queue across both history fetches so their combined
    // in-flight per-alert queries stay within one global cap.
    const historyQueryQueue = new PQueue({
      concurrency: ALERT_HISTORY_QUERY_CONCURRENCY,
    });
    const [previousAlerts, recentHistoryMap] = await Promise.all([
      getPreviousAlertHistories(alertIds, now, historyQueryQueue),
      getConsecutiveWindowHistories(alerts, now, historyQueryQueue),
    ]);

    for (const alert of alerts) {
      try {
        await loadAlert(
          alert,
          groupedTasks,
          previousAlerts,
          recentHistoryMap,
          now,
        );
      } catch (e) {
        logger.error({
          message: `failed to load alert: ${e}`,
          alertId: alert.id,
          team: alert.team,
          channel: alert.channel,
          provider: 'default',
        });
      }
    }

    // Flatten out our groupings for execution
    return Array.from(groupedTasks.values());
  }

  buildLogSearchLink({
    endTime,
    savedSearch,
    startTime,
  }: {
    endTime: Date;
    savedSearch: ISavedSearch;
    startTime: Date;
  }): string {
    const url = new URL(`${config.FRONTEND_URL}/search/${savedSearch.id}`);
    const queryParams = new URLSearchParams({
      from: startTime.getTime().toString(),
      to: endTime.getTime().toString(),
      isLive: 'false',
    });
    url.search = queryParams.toString();
    return url.toString();
  }

  buildChartLink({
    dashboardId,
    endTime,
    granularity,
    startTime,
    tileId,
  }: {
    dashboardId: string;
    endTime: Date;
    granularity: string;
    startTime: Date;
    tileId?: string;
  }): string {
    const url = new URL(`${config.FRONTEND_URL}/dashboards/${dashboardId}`);
    // extend both start and end time by 7x granularity
    const from = (startTime.getTime() - ms(granularity) * 7).toString();
    const to = (endTime.getTime() + ms(granularity) * 7).toString();
    const queryParams = new URLSearchParams({
      from,
      granularity: convertMsToGranularityString(ms(granularity)),
      to,
    });
    if (tileId) {
      queryParams.set('highlightedTileId', tileId);
    }
    url.search = queryParams.toString();
    return url.toString();
  }

  async updateAlertState(
    alertId: string,
    histories: IAlertHistory[],
    errors: IAlertError[],
  ) {
    // Save history records first (in parallel), then update alert state
    // Use Promise.allSettled to handle partial failures gracefully
    const historyResults = await Promise.allSettled(
      histories.map(history => AlertHistory.create(history)),
    );

    // Log any failed history saves but continue with alert state update
    const failedHistories = historyResults.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failedHistories.length > 0) {
      logger.error({
        message: 'Some alert history records failed to save',
        alertId,
        failedCount: failedHistories.length,
        totalCount: histories.length,
        errors: failedHistories.map(f => f.reason),
      });
    }

    // Determine final alert state: use successfully saved histories if any, otherwise fallback to computed state
    // The alert state is ALERT if ANY history (successful or computed) is in ALERT state, otherwise OK
    const successfulHistories = historyResults
      .map((result, index) =>
        result.status === 'fulfilled' ? histories[index] : null,
      )
      .filter((h): h is IAlertHistory => h !== null);

    const historiesToCheck =
      successfulHistories.length > 0 ? successfulHistories : histories;

    const finalState = historiesToCheck.some(h => h.state === AlertState.ALERT)
      ? AlertState.ALERT
      : historiesToCheck.some(h => h.state === AlertState.PENDING)
        ? AlertState.PENDING
        : AlertState.OK;

    // Update alert state + errors based on this execution
    await Alert.updateOne(
      { _id: new mongoose.Types.ObjectId(alertId) },
      { $set: { state: finalState, executionErrors: errors } },
    );

    // Dispatch agent investigations for freshly-fired histories that were
    // persisted (so a real _id exists). The eval loop only sets the
    // investigation marker when investigations are enabled, so the marker is
    // the single gate here. Suppressed fires get their marker cleared so a
    // marker only ever means "an investigation was actually requested". Must
    // never break the canonical state update above.
    const requestedDocs = historyResults
      .filter(
        (
          result,
        ): result is PromiseFulfilledResult<
          mongoose.HydratedDocument<IAlertHistory>
        > =>
          result.status === 'fulfilled' && result.value.investigation != null,
      )
      .map(result => result.value);

    if (requestedDocs.length > 0) {
      try {
        await this.dispatchInvestigations(alertId, requestedDocs);
      } catch (error) {
        logger.error(
          { alertId, error: String(error) },
          'Failed to dispatch agent investigations',
        );
      }
    }
  }

  /**
   * Gate a batch of freshly-fired histories (per-run budget, per-alert
   * cooldown via an atomic claim, per-evaluation cap) and dispatch the
   * survivors. Suppressed fires get their markers cleared. If every dispatch
   * in the batch fails, the claim is rolled back so the next fire retries.
   */
  private async dispatchInvestigations(
    alertId: string,
    requestedDocs: mongoose.HydratedDocument<IAlertHistory>[],
  ): Promise<void> {
    const clearAll = (docs: { _id: mongoose.Types.ObjectId }[]) =>
      clearInvestigationMarkers(docs.map(doc => doc._id));

    // Admins can turn investigations off team-wide (and authors per alert)
    // between marking and dispatch, so re-check both first: a disabled fire
    // must always label 'disabled', never 'budget' or 'skipped_team'. This is
    // a best-effort stop — a disable landing after this read but before the
    // POST still dispatches once. Markers are cleared so a marker only ever
    // means "an investigation was actually requested."
    const gateDoc = await Alert.findById(alertId).select(
      'team investigationsDisabled',
    );
    const gateTeam = gateDoc?.team
      ? await Team.findById(gateDoc.team).select('investigationsEnabled')
      : null;
    if (
      gateTeam?.investigationsEnabled === false ||
      gateDoc?.investigationsDisabled === true
    ) {
      alertInvestigationDispatchCounter.add(requestedDocs.length, {
        outcome: 'disabled',
      });
      await clearAll(requestedDocs);
      return;
    }

    if (this.investigationBudget <= 0) {
      alertInvestigationDispatchCounter.add(requestedDocs.length, {
        outcome: 'budget',
      });
      logger.warn(
        { alertId, suppressed: requestedDocs.length },
        'Suppressed agent investigation dispatches over the per-run budget',
      );
      await clearAll(requestedDocs);
      return;
    }

    // The agent holds the first team's credential; dispatching for any other
    // team would just fail the workflow's auth check every fire, so skip
    // those explicitly.
    if (this.installationTeamId === undefined) {
      const [firstTeam] = await getAllTeams(['_id']);
      this.installationTeamId = firstTeam?._id?.toString() ?? null;
    }
    const alertDoc = await Alert.findById(alertId).select('team');
    const alertTeamId = alertDoc?.team?.toString();
    if (!alertTeamId || alertTeamId !== this.installationTeamId) {
      alertInvestigationDispatchCounter.add(requestedDocs.length, {
        outcome: 'skipped_team',
      });
      logger.info(
        { alertId, suppressed: requestedDocs.length },
        'Skipped agent investigation dispatches for a team without the agent credential',
      );
      await clearAll(requestedDocs);
      return;
    }

    // Compare in evaluation-time (carried on the marker), not wall clock.
    const evalTime = new Date(
      Math.max(
        ...requestedDocs.map(doc => doc.investigation!.requestedAt.getTime()),
      ),
    );
    const releaseClaim = () =>
      Alert.updateOne(
        {
          _id: new mongoose.Types.ObjectId(alertId),
          investigationDispatchedAt: evalTime,
        },
        { $unset: { investigationDispatchedAt: '' } },
      ).catch(error =>
        logger.warn(
          { alertId, error: String(error) },
          'Failed to release investigation dispatch claim',
        ),
      );
    const cutoff = new Date(evalTime.getTime() - INVESTIGATION_COOLDOWN_MS);
    const claimed = await Alert.findOneAndUpdate(
      {
        _id: new mongoose.Types.ObjectId(alertId),
        $or: [
          { investigationDispatchedAt: { $exists: false } },
          { investigationDispatchedAt: { $lt: cutoff } },
        ],
      },
      { $set: { investigationDispatchedAt: evalTime } },
    );
    if (!claimed) {
      alertInvestigationDispatchCounter.add(requestedDocs.length, {
        outcome: 'cooldown',
      });
      logger.info(
        { alertId, suppressed: requestedDocs.length },
        'Suppressed agent investigation dispatches within the per-alert cooldown',
      );
      await clearAll(requestedDocs);
      return;
    }

    const toDispatch = requestedDocs.slice(
      0,
      Math.min(
        MAX_INVESTIGATION_DISPATCHES_PER_EVALUATION,
        this.investigationBudget,
      ),
    );
    const droppedDocs = requestedDocs.slice(toDispatch.length);
    this.investigationBudget -= toDispatch.length;
    if (droppedDocs.length > 0) {
      alertInvestigationDispatchCounter.add(droppedDocs.length, {
        outcome: 'failed',
      });
      logger.warn(
        {
          alertId,
          dropped: droppedDocs.length,
          cap: MAX_INVESTIGATION_DISPATCHES_PER_EVALUATION,
        },
        'Dropped agent investigation dispatches over the per-evaluation cap',
      );
      await clearAll(droppedDocs);
    }

    // The agent authenticates dispatches against its own credential, so forged
    // requests from other processes on the network cannot start paid runs.
    const credential = await ensureAgentCredential(alertTeamId).catch(error => {
      logger.warn(
        { alertId, error: String(error) },
        'Failed to resolve agent credential for investigation dispatch',
      );
      return null;
    });
    if (credential == null) {
      alertInvestigationDispatchCounter.add(toDispatch.length, {
        outcome: 'failed',
      });
      await Promise.all([clearAll(toDispatch), releaseClaim()]);
      return;
    }

    const batch = toDispatch.map(doc =>
      this.dispatchInvestigation(alertId, doc, credential),
    );
    const results = await Promise.all(batch);
    // Only definitive failures are cleaned up; an 'ambiguous' dispatch may
    // have been admitted, so its marker and claim stay.
    const failedDocs = toDispatch.filter((_, i) => results[i] === 'failed');
    if (failedDocs.length > 0) {
      await clearAll(failedDocs);
    }
    if (failedDocs.length === results.length) {
      // Nothing was requested: release the claim so the next fire retries.
      // Conditional on our own stamp so a newer claim survives.
      await releaseClaim();
    }
  }

  /**
   * POST one investigation request to the agent's workflow. Only identifiers
   * are passed — the agent looks up the alert and telemetry itself. Never
   * throws. A timeout is 'ambiguous': the agent may have durably admitted
   * the run before the connection gave up, so the caller must not treat it
   * as a definitive failure.
   */
  private async dispatchInvestigation(
    alertId: string,
    history: Pick<IAlertHistory, 'group' | 'createdAt'> & {
      _id: mongoose.Types.ObjectId;
    },
    credential: string,
  ): Promise<'dispatched' | 'failed' | 'ambiguous'> {
    try {
      const res = await fetch(config.AGENT_WORKFLOW_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${credential}`,
        },
        body: JSON.stringify({
          alertHistoryId: history._id.toString(),
          alertId,
          group: history.group,
          triggeredAt: history.createdAt,
        }),
        signal: AbortSignal.timeout(INVESTIGATION_DISPATCH_TIMEOUT_MS),
      });
      alertInvestigationDispatchCounter.add(1, {
        outcome: res.ok ? 'dispatched' : 'failed',
      });
      if (!res.ok) {
        logger.warn(
          { alertId, status: res.status },
          'Agent investigation dispatch returned a non-OK status',
        );
      }
      return res.ok ? 'dispatched' : 'failed';
    } catch (error) {
      const outcome =
        error instanceof Error && error.name === 'TimeoutError'
          ? 'ambiguous'
          : 'failed';
      alertInvestigationDispatchCounter.add(1, { outcome });
      logger.warn(
        { alertId, outcome, error: String(error) },
        'Failed to dispatch agent investigation',
      );
      return outcome;
    }
  }

  async recordAlertErrors(alertId: string, errors: IAlertError[]) {
    await Alert.updateOne(
      { _id: new mongoose.Types.ObjectId(alertId) },
      { $set: { executionErrors: errors } },
    );
  }

  async getWebhooks(teamId: string | ObjectId) {
    const webhooks = await Webhook.find({
      team: new mongoose.Types.ObjectId(teamId),
    });
    return new Map<string, IWebhook>(webhooks.map(w => [w.id, w]));
  }

  async getClickHouseClient(
    { host, username, password, id }: IConnection,
    requestTimeout?: number,
  ): Promise<ClickhouseClient> {
    if (!password && password !== '') {
      logger.info({
        message: `connection password not found`,
        connectionId: id,
        provider: 'default',
      });
    }

    return new ClickhouseClient({
      host,
      username,
      password,
      application: `hyperdx-alerts ${config.CODE_VERSION}`,
      requestTimeout: requestTimeout ?? 30_000,
    });
  }
}
