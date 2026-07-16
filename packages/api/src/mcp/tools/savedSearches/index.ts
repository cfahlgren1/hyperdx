import type {
  ToolDefinition,
  ToolRegistrar,
  WriteToolDefinition,
  WriteToolRegistrar,
} from '@/mcp/tools/types';

import { registerGetSavedSearch } from './getSavedSearch';
import { registerSaveSavedSearch } from './saveSavedSearch';

export const savedSearchesReadTools: ToolDefinition = (
  registrar: ToolRegistrar,
) => {
  registerGetSavedSearch(registrar);
};

export const savedSearchesWriteTools: WriteToolDefinition = (
  registrar: WriteToolRegistrar,
) => {
  registerSaveSavedSearch(registrar);
};
