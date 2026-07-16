import { connectMcpServer, type ToolDefinition } from '@flue/runtime';

const MCP_URL =
  process.env.HYPERDX_MCP_URL?.trim() || 'http://localhost:8000/mcp';

const CREDENTIAL_URL =
  process.env.HYPERDX_AGENT_CREDENTIAL_URL?.trim() ||
  'http://localhost:8001/agent/credential';
const CREDENTIAL_FETCH_ATTEMPTS = 24;
const CREDENTIAL_FETCH_DELAY_MS = 5_000;

/**
 * Resolve the MCP credential: an explicit env key wins, otherwise fetch the
 * agent credential ClickStack mints for this installation. The fetch retries
 * for ~2 minutes (the API may still be booting, or nobody has registered an
 * account yet) and then exits so the container's restart policy takes over.
 */
async function resolveCredential(): Promise<string> {
  const override = process.env.HYPERDX_MCP_ACCESS_KEY?.trim();
  if (override) {
    if (!override.startsWith('hdx_agent_')) {
      // A personal access key gets the FULL MCP tool surface (including
      // writes), and investigations run autonomously on untrusted telemetry.
      // Only the provisioned agent credential is server-enforced read-only.
      console.warn(
        'HYPERDX_MCP_ACCESS_KEY is not an agent credential: the assistant and alert investigations will run with this key’s full (write-capable) tool surface. Unset it to use the provisioned read-only agent credential.',
      );
    }
    return override;
  }

  for (let attempt = 1; attempt <= CREDENTIAL_FETCH_ATTEMPTS; attempt++) {
    const progress = `(attempt ${attempt}/${CREDENTIAL_FETCH_ATTEMPTS})`;
    try {
      // The header is what distinguishes this real client from a forged
      // SSRF request; the API rejects provisioning calls that lack it.
      const response = await fetch(CREDENTIAL_URL, {
        headers: { 'x-hyperdx-agent-provision': '1' },
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
          `Credential endpoint returned ${response.status}; set AGENT_CREDENTIAL_ENDPOINT_ENABLED=true on the app service or provide HYPERDX_MCP_ACCESS_KEY ${progress}`,
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

  // The server decides which tools this credential may use (agent credentials
  // get the read-only profile), so everything offered is taken as-is.
  const connection = await connectMcpServer('clickstack', {
    url: MCP_URL,
    headers: { authorization: `Bearer ${credential}` },
  });

  return { credential, tools: connection.tools };
}

const clickstack = await connectClickstack();

export const clickstackTools = clickstack.tools;

// The same read-only credential the agent uses for MCP also authenticates its
// investigation write-back to the ClickStack API (see workflows/investigateAlert.ts).
export const clickstackCredential = clickstack.credential;
