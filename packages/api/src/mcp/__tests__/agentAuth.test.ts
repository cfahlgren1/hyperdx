import request from 'supertest';

import * as config from '@/config';
import { ensureAgentCredential } from '@/controllers/agentInstallation';
import { getLoggedInAgent, getServer } from '@/fixtures';
import AgentInstallation from '@/models/agentInstallation';

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

  describe('GET /agent/credential', () => {
    it('is disabled by default', async () => {
      await getLoggedInAgent(server);
      await request(server.getHttpServer())
        .get('/agent/credential')
        .expect(404);
    });

    it('returns 409 before a team exists', async () => {
      jest.replaceProperty(
        config,
        'AGENT_CREDENTIAL_ENDPOINT_ENABLED' as never,
        true as never,
      );
      await request(server.getHttpServer())
        .get('/agent/credential')
        .expect(409);
    });

    it('serves an idempotent credential once a team exists', async () => {
      jest.replaceProperty(
        config,
        'AGENT_CREDENTIAL_ENDPOINT_ENABLED' as never,
        true as never,
      );
      await getLoggedInAgent(server);

      const first = await request(server.getHttpServer())
        .get('/agent/credential')
        .expect(200);
      const second = await request(server.getHttpServer())
        .get('/agent/credential')
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
});
