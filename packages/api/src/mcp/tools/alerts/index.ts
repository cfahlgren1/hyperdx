import type {
  ToolDefinition,
  ToolRegistrar,
  WriteToolDefinition,
  WriteToolRegistrar,
} from '@/mcp/tools/types';

import { registerGetAlert } from './getAlert';
import { registerGetWebhook } from './getWebhook';
import { registerSaveAlert } from './saveAlert';

export const alertsReadTools: ToolDefinition = (registrar: ToolRegistrar) => {
  registerGetAlert(registrar);
  registerGetWebhook(registrar);
};

export const alertsWriteTools: WriteToolDefinition = (
  registrar: WriteToolRegistrar,
) => {
  registerSaveAlert(registrar);
};
