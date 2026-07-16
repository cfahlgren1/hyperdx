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

// Tool-name patterns that mutate ClickStack state. The provisioned agent
// credential is server-enforced read-only, so this list never matches for it;
// it only applies when HYPERDX_MCP_ACCESS_KEY is a personal access key, whose
// full tool surface would otherwise hand write access to an autonomous agent
// reading untrusted telemetry.
const WRITE_TOOL_PATTERN = /save|delete|patch|create|update/i;

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

  if (credential.startsWith('hdx_agent_')) {
    return { credential, tools: connection.tools };
  }

  // Personal-key override: enforce read-only client-side by dropping mutation
  // tools, since the server grants this key its full surface.
  const tools = connection.tools.filter(
    tool => !WRITE_TOOL_PATTERN.test(tool.name),
  );
  const dropped = connection.tools.length - tools.length;
  if (dropped > 0) {
    console.warn(
      `HYPERDX_MCP_ACCESS_KEY is not an agent credential: dropped ${dropped} write-capable tools to keep the agent read-only. Unset it to use the provisioned agent credential.`,
    );
  }
  return { credential, tools };
}

const clickstack = await connectClickstack();

export const clickstackTools = clickstack.tools;

// The same read-only credential the agent uses for MCP also authenticates its
// investigation write-back to the ClickStack API.
export const clickstackCredential = clickstack.credential;
