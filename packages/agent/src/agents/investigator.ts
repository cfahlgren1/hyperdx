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
const MAX_SANDBOXES_PER_CONVERSATION = 4;

interface TrackedSandbox {
  bash: BashLike;
  seededMemory: Record<string, string>;
}

// Conversation sandboxes by instance id, so memory/ edits can be synced back
// to ClickStack when the agent goes idle (mirroring the workflow's post-run
// sync). Flue may initialize several harnesses per conversation, so every
// recent sandbox is kept and synced: untouched ones diff to nothing, and
// syncMemory updates each snapshot in place after a successful post.
const sandboxes = new Map<string, TrackedSandbox[]>();

observe(event => {
  if (event.type !== 'idle' || event.instanceId === undefined) {
    return;
  }
  const tracked = sandboxes.get(event.instanceId);
  if (tracked === undefined) {
    return;
  }
  for (const entry of tracked) {
    void syncMemory(entry.bash.fs, `${WORKSPACE}/`, entry.seededMemory);
  }
});

function track(id: string, entry: TrackedSandbox): void {
  const existing = sandboxes.get(id);
  if (existing !== undefined) {
    existing.push(entry);
    if (existing.length > MAX_SANDBOXES_PER_CONVERSATION) {
      existing.shift();
    }
    // Refresh LRU position: most recently active conversations evict last.
    sandboxes.delete(id);
    sandboxes.set(id, existing);
    return;
  }
  if (sandboxes.size >= MAX_TRACKED_CONVERSATIONS) {
    const oldest = sandboxes.keys().next().value;
    if (oldest !== undefined) {
      sandboxes.delete(oldest);
    }
  }
  sandboxes.set(id, [entry]);
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
