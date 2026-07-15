import { connectMcpServer, type ToolDefinition } from '@flue/runtime';

// Read-only subset of the ClickStack MCP server's tools. The server also
// exposes mutating dashboard/alert/saved-search tools, so this is an explicit
// allowlist — new server-side tools stay excluded until listed here.
const READ_ONLY_TOOLS = new Set([
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
]);

const MCP_TOOL_PREFIX = 'mcp__clickstack__';

async function connectClickstackTools(): Promise<ToolDefinition[]> {
  const url =
    process.env.HYPERDX_MCP_URL?.trim() || 'http://localhost:8000/mcp';
  const accessKey = process.env.HYPERDX_MCP_ACCESS_KEY?.trim();
  if (!accessKey) {
    throw new Error(
      'HYPERDX_MCP_ACCESS_KEY is required so the assistant can query ClickStack. Use your Personal API Access Key from Team Settings.',
    );
  }

  const connection = await connectMcpServer('clickstack', {
    url,
    headers: { authorization: `Bearer ${accessKey}` },
  });

  return connection.tools.filter(tool =>
    READ_ONLY_TOOLS.has(tool.name.replace(MCP_TOOL_PREFIX, '')),
  );
}

export const clickstackTools = await connectClickstackTools();
