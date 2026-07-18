import { type AgentRouteHandler, bash, defineAgent } from '@flue/runtime';
import { Bash } from 'just-bash';

import { requireAgentCredential } from '../auth.js';
import {
  contextFiles,
  conversationContextNote,
  fetchAgentContext,
} from '../context.js';
import { investigatorConfig } from '../investigator.js';

export const description =
  'A read-only observability investigator for ClickStack telemetry and alerts.';

// Exposed at /agents/investigator/:conversationId. Accepts the installation
// credential or a personal ClickStack API key from the same team.
export const route: AgentRouteHandler = requireAgentCredential;

const WORKSPACE = '/workspace';

// Conversational sessions get the same durable context an investigation run
// gets: the sandbox is seeded with the case-history and memory files, and the
// team instructions are appended to the system instructions.
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
    cwd: WORKSPACE,
    sandbox: bash(() => new Bash({ files, cwd: WORKSPACE })),
  };
});
