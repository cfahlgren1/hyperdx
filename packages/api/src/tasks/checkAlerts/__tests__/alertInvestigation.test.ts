import { ClickhouseClient } from '@hyperdx/common-utils/dist/clickhouse/node';
import mongoose from 'mongoose';
import ms from 'ms';

// Force the investigation feature on for this file. Dispatch goes through
// global.fetch, which each test mocks (so no real request escapes and no
// fire-and-forget promise outlives teardown).
jest.mock('@/config', () => ({
  ...jest.requireActual('@/config'),
  AGENT_INVESTIGATIONS_ENABLED: true,
  AGENT_WORKFLOW_URL: 'http://127.0.0.1:1/workflows/investigateAlert',
}));

import * as config from '@/config';
import { createAlert } from '@/controllers/alerts';
import { createTeam } from '@/controllers/team';
import { bulkInsertLogs, getServer } from '@/fixtures';
import Alert, { AlertSource, AlertThresholdType } from '@/models/alert';
import AlertHistory from '@/models/alertHistory';
import Connection from '@/models/connection';
import { SavedSearch } from '@/models/savedSearch';
import { Source } from '@/models/source';
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
    alertProvider = await loadProvider();
    server = getServer();
    await server.start();
  });

  beforeEach(() => {
    fetchMock = jest.fn().mockResolvedValue({ ok: true });
    global.fetch = fetchMock as any;
  });

  afterEach(async () => {
    global.fetch = realFetch;
    await server.clearDBs();
    jest.clearAllMocks();
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
  });
});
