import mongoose from 'mongoose';
import request from 'supertest';

import { ensureAgentCredential } from '@/controllers/agentInstallation';
import { getLoggedInAgent, getServer } from '@/fixtures';
import AgentInstallation from '@/models/agentInstallation';
import { AlertState, AlertThresholdType } from '@/models/alert';
import Alert from '@/models/alert';
import AlertHistory from '@/models/alertHistory';
import { createAgentCredentialApp } from '@/routers/agentCredential';

const MCP_HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
};

const TOOLS_LIST_BODY = {
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/list',
};

function mcpRequest(server: ReturnType<typeof getServer>, credential: string) {
  return request(server.getHttpServer())
    .post('/mcp')
    .set('Authorization', `Bearer ${credential}`)
    .set(MCP_HEADERS)
    .send(TOOLS_LIST_BODY);
}

/** Parse tool names out of a streamable-HTTP (SSE) tools/list response. */
function toolNamesFromSse(text: string): string[] {
  const dataLine = text.split('\n').find(line => line.startsWith('data: '));
  if (!dataLine) {
    throw new Error(`No SSE data line in response: ${text.slice(0, 200)}`);
  }
  const payload = JSON.parse(dataLine.slice('data: '.length));
  return payload.result.tools.map((t: { name: string }) => t.name);
}

describe('agent credential auth', () => {
  const server = getServer();

  beforeAll(async () => {
    await server.start();
  });

  afterEach(async () => {
    await server.clearDBs();
  });

  afterAll(async () => {
    await server.stop();
  });

  describe('ensureAgentCredential', () => {
    it('mints once and returns the same credential on later calls', async () => {
      const { team } = await getLoggedInAgent(server);
      const teamId = team._id.toString();

      const [first, second] = await Promise.all([
        ensureAgentCredential(teamId),
        ensureAgentCredential(teamId),
      ]);
      const third = await ensureAgentCredential(teamId);

      expect(first).toMatch(/^hdx_agent_/);
      expect(second).toBe(first);
      expect(third).toBe(first);
      expect(await AgentInstallation.countDocuments({ team: teamId })).toBe(1);
    });
  });

  describe('GET /agent/credential (internal listener)', () => {
    const credentialApp = createAgentCredentialApp();

    it('is not served by the public API', async () => {
      await getLoggedInAgent(server);
      await request(server.getHttpServer())
        .get('/agent/credential')
        .expect(404);
    });

    it('rejects requests without the provisioning header (SSRF guard)', async () => {
      await getLoggedInAgent(server);
      await request(credentialApp).get('/agent/credential').expect(403);
    });

    it('returns 409 before a team exists', async () => {
      await request(credentialApp)
        .get('/agent/credential')
        .set('x-hyperdx-agent-provision', '1')
        .expect(409);
    });

    it('serves an idempotent credential once a team exists', async () => {
      await getLoggedInAgent(server);

      const first = await request(credentialApp)
        .get('/agent/credential')
        .set('x-hyperdx-agent-provision', '1')
        .expect(200);
      const second = await request(credentialApp)
        .get('/agent/credential')
        .set('x-hyperdx-agent-provision', '1')
        .expect(200);

      expect(first.body.credential).toMatch(/^hdx_agent_/);
      expect(second.body.credential).toBe(first.body.credential);
    });
  });

  describe('MCP access', () => {
    it('gives the agent credential a read-only tool surface', async () => {
      const { team } = await getLoggedInAgent(server);
      const credential = await ensureAgentCredential(team._id.toString());

      const res = await mcpRequest(server, credential).expect(200);

      const toolNames = toolNamesFromSse(res.text);
      expect(toolNames).toContain('clickstack_list_sources');
      expect(toolNames).not.toContain('clickstack_save_dashboard');
      expect(toolNames).not.toContain('clickstack_save_alert');
    });

    it('keeps the full tool surface for personal access keys', async () => {
      const { user } = await getLoggedInAgent(server);

      const res = await mcpRequest(server, user.accessKey).expect(200);

      const toolNames = toolNamesFromSse(res.text);
      expect(toolNames).toContain('clickstack_list_sources');
      expect(toolNames).toContain('clickstack_save_dashboard');
    });

    it('rejects unknown credentials', async () => {
      await getLoggedInAgent(server);
      await mcpRequest(server, 'hdx_agent_not_a_real_credential').expect(401);
      await mcpRequest(server, 'not-a-real-key').expect(401);
    });
  });

  describe('credential isolation', () => {
    it('rejects the agent credential on External API v2', async () => {
      const { team } = await getLoggedInAgent(server);
      const credential = await ensureAgentCredential(team._id.toString());

      await request(server.getHttpServer())
        .get('/api/v2/sources')
        .set('Authorization', `Bearer ${credential}`)
        .expect(401);
    });
  });

  describe('POST /agent/investigations (write-back)', () => {
    const credentialApp = createAgentCredentialApp();

    const createHistory = async (
      teamId: mongoose.Types.ObjectId,
      { requested = true } = {},
    ) => {
      const alert = await Alert.create({
        team: teamId,
        threshold: 1,
        thresholdType: AlertThresholdType.ABOVE,
        interval: '5m',
        state: AlertState.ALERT,
      });
      const history = await AlertHistory.create({
        alert: alert._id,
        createdAt: new Date(),
        state: AlertState.ALERT,
        counts: 1,
        lastValues: [],
        ...(requested && { investigation: { requestedAt: new Date() } }),
      });
      return history;
    };

    it('stores the summary for the credential owning team', async () => {
      const { team } = await getLoggedInAgent(server);
      const credential = await ensureAgentCredential(team._id.toString());
      const history = await createHistory(team._id);

      await request(credentialApp)
        .post('/agent/investigations')
        .set('Authorization', `Bearer ${credential}`)
        .send({
          alertHistoryId: history._id.toString(),
          alertId: history.alert.toString(),
          summary: 'root cause: X',
          gist: 'X exhausted memory',
        })
        .expect(204);

      const updated = await AlertHistory.findById(history._id);
      expect(updated?.investigation?.summary).toBe('root cause: X');
      expect(updated?.investigation?.gist).toBe('X exhausted memory');
      expect(updated?.investigation?.completedAt).toBeTruthy();

      // A second write is rejected: delivered summaries are immutable.
      await request(credentialApp)
        .post('/agent/investigations')
        .set('Authorization', `Bearer ${credential}`)
        .send({
          alertHistoryId: history._id.toString(),
          alertId: history.alert.toString(),
          summary: 'overwrite attempt',
          gist: 'gist',
        })
        .expect(409);
    });

    it('rejects a personal access key: only the agent credential may write', async () => {
      const { team, user } = await getLoggedInAgent(server);
      const history = await createHistory(team._id);

      await request(credentialApp)
        .post('/agent/investigations')
        .set('Authorization', `Bearer ${user.accessKey}`)
        .send({
          alertHistoryId: history._id.toString(),
          alertId: history.alert.toString(),
          summary: 'via access key',
          gist: 'gist',
        })
        .expect(401);

      const updated = await AlertHistory.findById(history._id);
      expect(updated?.investigation?.summary).toBeUndefined();
    });

    it('rejects unsolicited summaries for histories never marked for investigation (409)', async () => {
      const { team } = await getLoggedInAgent(server);
      const credential = await ensureAgentCredential(team._id.toString());
      // No investigation marker: nobody asked for this summary.
      const history = await createHistory(team._id, { requested: false });

      await request(credentialApp)
        .post('/agent/investigations')
        .set('Authorization', `Bearer ${credential}`)
        .send({
          alertHistoryId: history._id.toString(),
          alertId: history.alert.toString(),
          summary: 'spam',
          gist: 'gist',
        })
        .expect(409);
    });

    it('rejects a missing or unknown credential', async () => {
      const { team } = await getLoggedInAgent(server);
      const history = await createHistory(team._id);
      const body = {
        alertHistoryId: history._id.toString(),
        alertId: history.alert.toString(),
        summary: 'nope',
        gist: 'gist',
      };

      await request(credentialApp)
        .post('/agent/investigations')
        .send(body)
        .expect(401);
      await request(credentialApp)
        .post('/agent/investigations')
        .set('Authorization', 'Bearer hdx_agent_not_real')
        .send(body)
        .expect(401);
    });

    it('rejects a credential from another team (403)', async () => {
      const { team } = await getLoggedInAgent(server);
      const credential = await ensureAgentCredential(team._id.toString());
      // History belongs to a different team.
      const history = await createHistory(new mongoose.Types.ObjectId());

      await request(credentialApp)
        .post('/agent/investigations')
        .set('Authorization', `Bearer ${credential}`)
        .send({
          alertHistoryId: history._id.toString(),
          alertId: history.alert.toString(),
          summary: 'leak',
          gist: 'gist',
        })
        .expect(403);
    });

    it('returns 404 for an unknown alert history id', async () => {
      const { team } = await getLoggedInAgent(server);
      const credential = await ensureAgentCredential(team._id.toString());

      await request(credentialApp)
        .post('/agent/investigations')
        .set('Authorization', `Bearer ${credential}`)
        .send({
          alertHistoryId: new mongoose.Types.ObjectId().toString(),
          alertId: new mongoose.Types.ObjectId().toString(),
          summary: 'ghost',
          gist: 'gist',
        })
        .expect(404);
      await request(credentialApp)
        .post('/agent/investigations')
        .set('Authorization', `Bearer ${credential}`)
        .send({
          alertHistoryId: 'not-an-object-id',
          alertId: new mongoose.Types.ObjectId().toString(),
          summary: 'ghost',
          gist: 'gist',
        })
        .expect(404);
    });

    it('rejects a history/alert mismatch (409)', async () => {
      const { team } = await getLoggedInAgent(server);
      const credential = await ensureAgentCredential(team._id.toString());
      const history = await createHistory(team._id);

      // Valid history, but paired with a different alert id: findings must
      // not be grafted onto another alert's record.
      await request(credentialApp)
        .post('/agent/investigations')
        .set('Authorization', `Bearer ${credential}`)
        .send({
          alertHistoryId: history._id.toString(),
          alertId: new mongoose.Types.ObjectId().toString(),
          summary: 'grafted',
          gist: 'gist',
        })
        .expect(409);
      const after = await AlertHistory.findById(history._id);
      expect(after?.investigation?.summary).toBeUndefined();
    });
  });
});
