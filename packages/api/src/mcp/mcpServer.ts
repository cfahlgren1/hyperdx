import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { CODE_VERSION } from '@/config';

import dashboardPrompts from './prompts/dashboards/index';
import { alertsReadTools, alertsWriteTools } from './tools/alerts/index';
import {
  dashboardsReadTools,
  dashboardsWriteTools,
} from './tools/dashboards/index';
import queryTools from './tools/query/index';
import {
  savedSearchesReadTools,
  savedSearchesWriteTools,
} from './tools/savedSearches/index';
import sourcesTools from './tools/sources/index';
import traceTools from './tools/trace/index';
import { McpContext } from './tools/types';
import { createRegisterTool } from './utils/registerTool';

export function createServer(context: McpContext) {
  const server = new McpServer({
    name: 'clickstack',
    version: `${CODE_VERSION}-beta`,
  });

  const registerTool = createRegisterTool(server, context);
  const registrar = { server, context, registerTool };

  sourcesTools(registrar);
  queryTools(registrar);
  traceTools(registrar);
  alertsReadTools(registrar);
  dashboardsReadTools(registrar);
  savedSearchesReadTools(registrar);

  // Write tools mutate team metadata in MongoDB, so this registration gate is
  // the authorization boundary for read-only principals — a tool that is
  // never registered cannot be invoked.
  if (context.access === 'full') {
    const writeRegistrar = { server, context, registerTool };
    alertsWriteTools(writeRegistrar);
    dashboardsWriteTools(writeRegistrar);
    savedSearchesWriteTools(writeRegistrar);
  }

  dashboardPrompts(server, context);

  return server;
}
