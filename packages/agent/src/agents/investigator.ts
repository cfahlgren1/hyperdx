import {
  type AgentRouteHandler,
  bash,
  type BashLike,
  defineAgent,
  observe,
} from '@flue/runtime';
import { Bash } from 'just-bash';

import { requireAgentCredential } from '../auth.js';
import {
  contextFiles,
  conversationContextNote,
  fetchAgentContext,
  syncMemory,
} from '../context.js';
import { investigatorConfig } from '../investigator.js';

export const description =
  'A read-only observability investigator for ClickStack telemetry and alerts.';

// Accepts the installation credential or a personal API key from the team.
export const route: AgentRouteHandler = requireAgentCredential;

const WORKSPACE = '/workspace';
const MAX_TRACKED_CONVERSATIONS = 50;

interface TrackedSandbox {
  bash: BashLike;
  seededMemory: Record<string, string>;
}

// Latest sandbox per conversation, so memory/ edits can be synced back to
// ClickStack when the agent goes idle (mirroring the workflow's post-run
// sync). Best-effort: an edit in a sandbox flue has since replaced is lost.
const sandboxes = new Map<string, TrackedSandbox>();

observe(event => {
  if (event.type !== 'idle' || event.instanceId === undefined) {
    return;
  }
  const tracked = sandboxes.get(event.instanceId);
  if (tracked !== undefined) {
    void syncMemory(tracked.bash.fs, `${WORKSPACE}/`, tracked.seededMemory);
  }
});

function track(id: string, entry: TrackedSandbox): void {
  if (!sandboxes.has(id) && sandboxes.size >= MAX_TRACKED_CONVERSATIONS) {
    const oldest = sandboxes.keys().next().value;
    if (oldest !== undefined) {
      sandboxes.delete(oldest);
    }
  }
  sandboxes.set(id, entry);
}

// Conversations get the same seeded workspace an investigation run gets.
export default defineAgent(async ({ id }) => {
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
    sandbox: bash(() => {
      const sandbox = new Bash({ files, cwd: WORKSPACE });
      track(id, {
        bash: sandbox,
        seededMemory: Object.fromEntries(
          context.memories.map(memory => [memory.slug, memory.content]),
        ),
      });
      return sandbox;
    }),
  };
});
