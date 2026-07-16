import type { McpContext } from '@/mcp/tools/types';

import { createTestClient } from './mcpTestUtils';

const TEAM_ID = '000000000000000000000001';

const READ_TOOLS = [
  'clickstack_describe_metric',
  'clickstack_describe_source',
  'clickstack_event_deltas',
  'clickstack_event_patterns',
  'clickstack_get_alert',
  'clickstack_get_dashboard',
  'clickstack_get_dashboard_tile',
  'clickstack_get_saved_search',
  'clickstack_get_webhook',
  'clickstack_list_metrics',
  'clickstack_list_sources',
  'clickstack_query_tile',
  'clickstack_search',
  'clickstack_search_dashboards',
  'clickstack_sql',
  'clickstack_table',
  'clickstack_timeseries',
  'clickstack_trace_top_time_consuming_operations',
  'clickstack_trace_waterfall',
].sort();

const WRITE_TOOLS = [
  'clickstack_delete_dashboard',
  'clickstack_patch_dashboard',
  'clickstack_save_alert',
  'clickstack_save_dashboard',
  'clickstack_save_saved_search',
].sort();

const agentContext: McpContext = {
  teamId: TEAM_ID,
  access: 'read',
  principal: { kind: 'agent', id: '000000000000000000000002' },
};

const userContext: McpContext = {
  teamId: TEAM_ID,
  access: 'full',
  principal: { kind: 'user', id: '000000000000000000000003' },
};

async function listToolNames(context: McpContext): Promise<string[]> {
  const client = await createTestClient(context);
  const { tools } = await client.listTools();
  return tools.map(t => t.name).sort();
}

async function listPromptNames(context: McpContext): Promise<string[]> {
  const client = await createTestClient(context);
  const { prompts } = await client.listPrompts();
  return prompts.map(p => p.name).sort();
}

describe('MCP read-only profile', () => {
  it('registers exactly the read tools for a read-only agent principal', async () => {
    expect(await listToolNames(agentContext)).toEqual(READ_TOOLS);
  });

  it('registers the full tool surface for a user principal', async () => {
    expect(await listToolNames(userContext)).toEqual(
      [...READ_TOOLS, ...WRITE_TOOLS].sort(),
    );
  });

  it.each(WRITE_TOOLS)(
    'rejects the write tool %s for a read-only agent principal',
    async toolName => {
      const client = await createTestClient(agentContext);
      const result = await client.callTool({ name: toolName, arguments: {} });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toMatch(/not found/i);
    },
  );

  it('omits the create_dashboard prompt for a read-only agent principal', async () => {
    expect(await listPromptNames(agentContext)).toEqual([
      'dashboard_examples',
      'query_guide',
    ]);
  });

  it('keeps all prompts for a user principal', async () => {
    expect(await listPromptNames(userContext)).toEqual([
      'create_dashboard',
      'dashboard_examples',
      'query_guide',
    ]);
  });
});
