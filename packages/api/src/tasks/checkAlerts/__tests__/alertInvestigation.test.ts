import { ClickhouseClient } from '@hyperdx/common-utils/dist/clickhouse/node';
import mongoose from 'mongoose';
import ms from 'ms';

// Force the investigation feature on for this file. Dispatch goes through
// global.fetch, which each test mocks so no real request escapes.
jest.mock('@/config', () => ({
  ...jest.requireActual('@/config'),
  AGENT_INVESTIGATIONS_ENABLED: true,
  AGENT_WORKFLOW_URL: 'http://127.0.0.1:1/workflows/investigateAlert',
}));

import * as config from '@/config';
import * as agentInstallation from '@/controllers/agentInstallation';
import { createAlert } from '@/controllers/alerts';
import { createTeam } from '@/controllers/team';
import { bulkInsertLogs, getServer } from '@/fixtures';
import Alert, { AlertSource, AlertThresholdType } from '@/models/alert';
import AlertHistory from '@/models/alertHistory';
import Connection from '@/models/connection';
import { SavedSearch } from '@/models/savedSearch';
import { Source } from '@/models/source';
import Team from '@/models/team';
import Webhook from '@/models/webhook';
import { AggregatedAlertHistory, processAlert } from '@/tasks/checkAlerts';
import { AlertTaskType, loadProvider } from '@/tasks/checkAlerts/providers';
import * as slack from '@/utils/slack';

describe('Alert investigation edge marking', () => {
  let alertProvider: any;
  let server: any;
  let fetchMock: jest.Mock;
  const realFetch = global.fetch;

  beforeAll(async () => {
    server = getServer();
    await server.start();
  });

  beforeEach(async () => {
    // Fresh provider per test: it caches the installation team and the
    // per-run dispatch budget, both of which must not leak across tests.
    alertProvider = await loadProvider();
    fetchMock = jest.fn().mockResolvedValue({ ok: true });
    global.fetch = fetchMock as any;
  });

  afterEach(async () => {
    global.fetch = realFetch;
    await server.clearDBs();
    jest.clearAllMocks();
  });

  /** Minimal fresh-fire history object as the eval loop would produce it. */
  const freshFireHistory = (alertId: mongoose.Types.ObjectId) => ({
    alert: alertId,
    createdAt: new Date(),
    state: 'ALERT',
    counts: 1,
    fired: true,
    lastValues: [{ startTime: new Date(), count: 5 }],
    investigation: { requestedAt: new Date() },
  });

  const createTeamAlert = async (teamId: mongoose.Types.ObjectId) =>
    Alert.create({
      team: teamId,
      threshold: 1,
      thresholdType: AlertThresholdType.ABOVE,
      interval: '1m',
      state: 'OK',
    });

  afterAll(async () => {
    await server.stop();
  });

  const setupBreachingAlert = async () => {
    const team = await createTeam({ name: 'Test Team' });
    const connection = await Connection.create({
      team: team._id,
      name: 'Test Connection',
      host: config.CLICKHOUSE_HOST,
      username: config.CLICKHOUSE_USER,
      password: config.CLICKHOUSE_PASSWORD,
    });
    const source = await Source.create({
      kind: 'log',
      team: team._id,
      from: { databaseName: 'default', tableName: 'otel_logs' },
      timestampValueExpression: 'Timestamp',
      connection: connection.id,
      name: 'Test Logs',
    });
    const savedSearch = await new SavedSearch({
      team: team._id,
      name: 'Error Logs Search',
      select: 'Body',
      where: 'SeverityText: "error"',
      whereLanguage: 'lucene',
      orderBy: 'Timestamp',
      source: source.id,
      tags: ['test'],
    }).save();
    const webhook = await new Webhook({
      team: team._id,
      service: 'slack',
      url: 'https://hooks.slack.com/services/test123',
      name: 'Test Webhook',
    }).save();
    const alert = await createAlert(
      team._id,
      {
        source: AlertSource.SAVED_SEARCH,
        channel: { type: 'webhook', webhookId: webhook._id.toString() },
        interval: '5m',
        thresholdType: AlertThresholdType.ABOVE,
        threshold: 1,
        savedSearchId: savedSearch.id,
        name: 'Test Alert Name',
      },
      new mongoose.Types.ObjectId(),
    );

    const now = new Date('2023-11-16T22:12:00.000Z');
    const eventTime = new Date(now.getTime() - ms('3m'));
    await bulkInsertLogs([
      {
        ServiceName: 'api',
        Timestamp: eventTime,
        SeverityText: 'error',
        Body: 'Test error message',
      },
      {
        ServiceName: 'api',
        Timestamp: eventTime,
        SeverityText: 'error',
        Body: 'Test error message',
      },
    ]);

    const enhancedAlert: any = await Alert.findById(alert.id).populate([
      'team',
      'savedSearch',
    ]);
    const clickhouseClient = new ClickhouseClient({
      host: connection.host,
      username: connection.username,
      password: connection.password,
    });

    const run = (previousMap: Map<string, AggregatedAlertHistory>) =>
      processAlert(
        now,
        {
          alert: enhancedAlert,
          source,
          conn: connection,
          taskType: AlertTaskType.SAVED_SEARCH,
          savedSearch,
          previousMap,
        } as any,
        clickhouseClient,
        connection.id,
        alertProvider,
        new Map([[webhook.id.toString(), webhook]]),
      );

    return { alert, run };
  };

  it('marks a fresh fire pending exactly once (not on the sustained tick)', async () => {
    jest.spyOn(slack, 'postMessageToWebhook').mockResolvedValue(null as any);
    const { alert, run } = await setupBreachingAlert();

    // First evaluation: OK -> ALERT edge, no prior history.
    await run(new Map());

    const afterFirst = await AlertHistory.find({ alert: alert.id });
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0].state).toBe('ALERT');
    expect(afterFirst[0].investigation?.requestedAt).toBeTruthy();

    // The dispatch carries the persisted history id.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [dispatchUrl, dispatchInit] = fetchMock.mock.calls[0];
    expect(dispatchUrl).toBe('http://127.0.0.1:1/workflows/investigateAlert');
    expect(JSON.parse(dispatchInit.body)).toMatchObject({
      alertHistoryId: afterFirst[0]._id.toString(),
      alertId: alert.id,
    });

    // Second evaluation while still breaching: previous already fired, so the
    // new history must NOT be marked (no re-investigation of a sustained alert).
    const previousMap = new Map<string, AggregatedAlertHistory>([
      [alert.id, { state: 'ALERT', fired: true } as any],
    ]);
    await run(previousMap);

    const all = await AlertHistory.find({ alert: alert.id });
    const marked = all.filter(h => h.investigation != null);
    expect(marked).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Third evaluation: the alert resolved and re-fired within the cooldown
    // window (a flapper). The fresh edge is marked by the eval loop, but the
    // provider suppresses the dispatch and clears the marker, so only
    // actually-dispatched fires extend the cooldown.
    const reFireMap = new Map<string, AggregatedAlertHistory>([
      [alert.id, { state: 'OK', fired: true } as any],
    ]);
    await run(reFireMap);

    const afterReFire = await AlertHistory.find({ alert: alert.id });
    expect(afterReFire.filter(h => h.investigation != null)).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('dispatches exactly once for concurrent evaluations of the same alert (atomic claim)', async () => {
    const team = await createTeam({ name: 'Claim Team' });
    const alert = await createTeamAlert(team._id);

    // Two overlapping evaluators both persist a fresh-fire history and race
    // to dispatch. The atomic claim must produce exactly one winner — not
    // zero (mutual suppression) and not two (double dispatch).
    await Promise.all([
      alertProvider.updateAlertState(
        alert._id.toString(),
        [freshFireHistory(alert._id)],
        [],
      ),
      alertProvider.updateAlertState(
        alert._id.toString(),
        [freshFireHistory(alert._id)],
        [],
      ),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('authenticates dispatches with the team agent credential', async () => {
    const team = await createTeam({ name: 'Auth Team' });
    const alert = await createTeamAlert(team._id);

    await alertProvider.updateAlertState(
      alert._id.toString(),
      [freshFireHistory(alert._id)],
      [],
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.authorization).toMatch(/^Bearer hdx_agent_/);
    expect(JSON.parse(init.body).alertId).toBe(alert._id.toString());
  });

  it('caps dispatches at the per-run budget across alerts', async () => {
    const team = await createTeam({ name: 'Budget Team' });
    const alerts = await Promise.all(
      Array.from({ length: 12 }, () => createTeamAlert(team._id)),
    );

    for (const alert of alerts) {
      await alertProvider.updateAlertState(
        alert._id.toString(),
        [freshFireHistory(alert._id)],
        [],
      );
    }

    // MAX_INVESTIGATION_DISPATCHES_PER_RUN = 10; the last two are suppressed
    // and their markers cleared so they don't read as requested.
    expect(fetchMock).toHaveBeenCalledTimes(10);
    const marked = await AlertHistory.countDocuments({
      investigation: { $exists: true },
    });
    expect(marked).toBe(10);
  });

  it('skips dispatch for teams other than the installation team', async () => {
    const firstTeam = await createTeam({ name: 'First Team' });
    const otherTeamId = new mongoose.Types.ObjectId();
    const firstAlert = await createTeamAlert(firstTeam._id);
    const otherAlert = await createTeamAlert(otherTeamId);

    await alertProvider.updateAlertState(
      firstAlert._id.toString(),
      [freshFireHistory(firstAlert._id)],
      [],
    );
    await alertProvider.updateAlertState(
      otherAlert._id.toString(),
      [freshFireHistory(otherAlert._id)],
      [],
    );

    // Only the installation (first) team dispatches; the other team's marker
    // is cleared rather than failing the workflow auth every fire.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).alertId).toBe(
      firstAlert._id.toString(),
    );
    const otherMarked = await AlertHistory.countDocuments({
      alert: otherAlert._id,
      investigation: { $exists: true },
    });
    expect(otherMarked).toBe(0);
  });

  it('skips dispatch when the team has investigations disabled', async () => {
    const team = await createTeam({ name: 'Test Team' });
    await Team.updateOne(
      { _id: team._id },
      { $set: { investigationsEnabled: false } },
    );
    const alert = await createTeamAlert(team._id);

    await alertProvider.updateAlertState(
      alert._id.toString(),
      [freshFireHistory(alert._id)],
      [],
    );

    expect(fetchMock).not.toHaveBeenCalled();
    const marked = await AlertHistory.countDocuments({
      alert: alert._id,
      investigation: { $exists: true },
    });
    expect(marked).toBe(0);
  });

  it('skips dispatch when the alert opts out of investigations', async () => {
    const team = await createTeam({ name: 'Test Team' });
    const alert = await createTeamAlert(team._id);
    await Alert.updateOne(
      { _id: alert._id },
      { $set: { investigationsDisabled: true } },
    );

    await alertProvider.updateAlertState(
      alert._id.toString(),
      [freshFireHistory(alert._id)],
      [],
    );

    expect(fetchMock).not.toHaveBeenCalled();
    const marked = await AlertHistory.countDocuments({
      alert: alert._id,
      investigation: { $exists: true },
    });
    expect(marked).toBe(0);
  });

  it('releases the dispatch claim when every dispatch in the batch fails', async () => {
    fetchMock.mockRejectedValue(new Error('agent down'));
    const team = await createTeam({ name: 'Rollback Team' });
    const alert = await createTeamAlert(team._id);

    await alertProvider.updateAlertState(
      alert._id.toString(),
      [freshFireHistory(alert._id)],
      [],
    );

    const doc = await Alert.findById(alert._id).select(
      'investigationDispatchedAt',
    );
    expect(doc?.investigationDispatchedAt).toBeUndefined();

    // The failed fire's marker is cleared too, so a later fire retries.
    const marked = await AlertHistory.countDocuments({
      alert: alert._id,
      investigation: { $exists: true },
    });
    expect(marked).toBe(0);
  });

  it('does not dispatch without an agent credential', async () => {
    jest
      .spyOn(agentInstallation, 'ensureAgentCredential')
      .mockRejectedValueOnce(new Error('credential unavailable'));
    const team = await createTeam({ name: 'Credential Failure Team' });
    const alert = await createTeamAlert(team._id);

    await alertProvider.updateAlertState(
      alert._id.toString(),
      [freshFireHistory(alert._id)],
      [],
    );

    expect(fetchMock).not.toHaveBeenCalled();
    const marked = await AlertHistory.countDocuments({
      alert: alert._id,
      investigation: { $exists: true },
    });
    expect(marked).toBe(0);
    const doc = await Alert.findById(alert._id).select(
      'investigationDispatchedAt',
    );
    expect(doc?.investigationDispatchedAt).toBeUndefined();
  });

  it('keeps the marker and claim when a dispatch times out (ambiguous)', async () => {
    // A timeout is ambiguous: the agent may have admitted the run before the
    // connection gave up. Clearing the marker would 409 the eventual
    // write-back, and releasing the claim would allow a duplicate run.
    const timeoutError = new Error('The operation was aborted due to timeout');
    timeoutError.name = 'TimeoutError';
    fetchMock.mockRejectedValue(timeoutError);
    const team = await createTeam({ name: 'Ambiguous Team' });
    const alert = await createTeamAlert(team._id);

    await alertProvider.updateAlertState(
      alert._id.toString(),
      [freshFireHistory(alert._id)],
      [],
    );
    const marked = await AlertHistory.countDocuments({
      alert: alert._id,
      investigation: { $exists: true },
    });
    expect(marked).toBe(1);
    const doc = await Alert.findById(alert._id).select(
      'investigationDispatchedAt',
    );
    expect(doc?.investigationDispatchedAt).toBeTruthy();
  });
});
