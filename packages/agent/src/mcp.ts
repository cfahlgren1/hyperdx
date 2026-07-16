import { connectMcpServer, type ToolDefinition } from '@flue/runtime';

const MCP_URL =
  process.env.HYPERDX_MCP_URL?.trim() || 'http://localhost:8000/mcp';

const CREDENTIAL_URL =
  process.env.HYPERDX_AGENT_CREDENTIAL_URL?.trim() ||
  'http://localhost:8001/agent/credential';
const CREDENTIAL_FETCH_ATTEMPTS = 24;
const CREDENTIAL_FETCH_DELAY_MS = 5_000;
const CREDENTIAL_FETCH_TIMEOUT_MS = 5_000;

/**
 * Fetch the agent credential ClickStack mints for this installation. Retries
 * for ~2 minutes (the API may still be booting, or nobody has registered an
 * account yet) and then exits so the container's restart policy takes over.
 */
async function resolveCredential(): Promise<string> {
  for (let attempt = 1; attempt <= CREDENTIAL_FETCH_ATTEMPTS; attempt++) {
    const progress = `(attempt ${attempt}/${CREDENTIAL_FETCH_ATTEMPTS})`;
    try {
      // The header is what distinguishes this real client from a forged
      // SSRF request; the API rejects provisioning calls that lack it.
      const response = await fetch(CREDENTIAL_URL, {
        headers: { 'x-hyperdx-agent-provision': '1' },
        // Bound each attempt so a stalled connection cannot eat the whole
        // retry budget.
        signal: AbortSignal.timeout(CREDENTIAL_FETCH_TIMEOUT_MS),
      });
      if (response.ok) {
        const { credential } = (await response.json()) as {
          credential?: string;
        };
        if (credential) {
          return credential;
        }
      } else if (response.status === 409) {
        console.log(
          `Waiting for ClickStack registration — create an account in the app first ${progress}`,
        );
      } else {
        console.log(
          `Credential endpoint returned ${response.status}; set AGENT_INVESTIGATIONS_ENABLED=true on the app service ${progress}`,
        );
      }
    } catch {
      console.log(
        `Waiting for the ClickStack API at ${CREDENTIAL_URL} ${progress}`,
      );
    }
    await new Promise(resolve =>
      setTimeout(resolve, CREDENTIAL_FETCH_DELAY_MS),
    );
  }

  console.error(
    'Could not obtain a ClickStack agent credential; exiting so the container can retry.',
  );
  return process.exit(1);
}

async function connectClickstack(): Promise<{
  credential: string;
  tools: ToolDefinition[];
}> {
  const credential = await resolveCredential();

  // The server enforces the credential's read-only tool profile, so
  // everything offered is taken as-is.
  const connection = await connectMcpServer('clickstack', {
    url: MCP_URL,
    headers: { authorization: `Bearer ${credential}` },
  });

  return { credential, tools: connection.tools };
}

const clickstack = await connectClickstack();

export const clickstackTools = clickstack.tools;

// The same read-only credential the agent uses for MCP also authenticates its
// investigation write-back to the ClickStack API.
export const clickstackCredential = clickstack.credential;
