import { type AgentRouteHandler, bash, defineAgent } from '@flue/runtime';
import { Bash } from 'just-bash';

import { requireAgentCredential } from '../auth.js';
import {
  contextFiles,
  conversationContextNote,
  fetchAgentContext,
} from '../context.js';
import { investigatorConfig } from '../investigator.js';
import { updateMemory } from '../tools/memory.js';

export const description =
  'A read-only observability investigator for ClickStack telemetry and alerts.';

// Accepts the installation credential or a personal API key from the team.
export const route: AgentRouteHandler = requireAgentCredential;

const WORKSPACE = '/workspace';

// Conversations get the same seeded workspace an investigation run gets, and
// persist durable notes through the update_memory tool.
export default defineAgent(async () => {
  const base = investigatorConfig();
  const context = await fetchAgentContext();
  const files = Object.fromEntries(
    Object.entries(contextFiles(context)).map(([path, content]) => [
      `${WORKSPACE}/${path}`,
      content,
    ]),
  );
  return {
    ...base,
    instructions: base.instructions + conversationContextNote(context),
    tools: [...base.tools, updateMemory],
    cwd: WORKSPACE,
    sandbox: bash(() => new Bash({ files, cwd: WORKSPACE })),
  };
});
