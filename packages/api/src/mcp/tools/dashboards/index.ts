import type {
  ToolDefinition,
  ToolRegistrar,
  WriteToolDefinition,
  WriteToolRegistrar,
} from '@/mcp/tools/types';

import { registerDeleteDashboard } from './deleteDashboard';
import { registerGetDashboard } from './getDashboard';
import { registerGetDashboardTile } from './getDashboardTile';
import { registerPatchDashboard } from './patchDashboard';
import { registerQueryTile } from './queryTile';
import { registerSaveDashboard } from './saveDashboard';
import { registerSearchDashboards } from './searchDashboards';

export * from './schemas';

export const dashboardsReadTools: ToolDefinition = (
  registrar: ToolRegistrar,
) => {
  registerGetDashboard(registrar);
  registerGetDashboardTile(registrar);
  registerSearchDashboards(registrar);
  registerQueryTile(registrar);
};

export const dashboardsWriteTools: WriteToolDefinition = (
  registrar: WriteToolRegistrar,
) => {
  registerSaveDashboard(registrar);
  registerPatchDashboard(registrar);
  registerDeleteDashboard(registrar);
};
