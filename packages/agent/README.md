# @hyperdx/agent

Optional AI on-call agent for self-hosted ClickStack, built on
[Flue](https://flue.dev). It takes the first pass at alerts and observability
questions, investigating with telemetry context and reporting findings, so
on-call starts with answers instead of raw signals.

## Usage

With `ANTHROPIC_API_KEY` in your environment (or in `packages/agent/.env`),
start the dev server from the repository root:

```bash
yarn workspace @hyperdx/agent dev
```

Chat with the assistant. The trailing path segment is the conversation ID, so
reusing it continues the conversation:

```bash
curl -X POST 'http://127.0.0.1:4010/agents/assistant/my-chat?wait=result' \
  -H 'content-type: application/json' \
  -d '{"message":"Explain what an SRE should check after a latency alert."}'
```

Override the model with `AI_MODEL_NAME` (default `claude-sonnet-5`),
and point `ANTHROPIC_BASE_URL` at any Anthropic-compatible endpoint to use other
models, like [OpenRouter](https://openrouter.ai/docs) or the
[Vercel AI Gateway](https://vercel.com/docs/ai-gateway/coding-agents/claude-code).
Conversations are stored in a SQLite file under `.volumes/agent/` (override with
`FLUE_DB_PATH`).

## ClickStack tools

The assistant queries ClickStack through the API's MCP server, which serves
agent credentials a read-only tool profile (search, SQL, traces,
dashboards/alerts reads, no writes). In Docker Compose the agent provisions
its credential itself; for local dev set `HYPERDX_MCP_ACCESS_KEY` to a
personal API access key from Team Settings. The MCP server defaults to
`http://localhost:8000/mcp` (override with `HYPERDX_MCP_URL`).

## Alert investigations

When an alert fires, the agent can investigate it automatically: the API
dispatches the fire to the agent's `investigateAlert` workflow, the agent
queries the underlying telemetry with its read-only tools, and the findings
summary is stored on the alert history and shown in the app under
**Alerts → Investigations**.

Enable it on the API (`app` service) with `AGENT_INVESTIGATIONS_ENABLED=true`
— off by default. In Docker Compose:

```bash
ANTHROPIC_API_KEY="..." AGENT_INVESTIGATIONS_ENABLED=true \
  docker compose --profile agent up -d
```

Behavior and cost controls (all server-side, in the alert task):

- Investigations run once per **fresh fire** (the OK→ALERT edge), never on
  every tick of a sustained breach.
- At most one investigation per alert per hour (atomic claim on the alert, so
  flapping alerts can't burn tokens), at most 5 per evaluation for grouped
  alerts, and at most 10 per task run across all alerts.
- Delivery is at-most-once: if the agent is down or the model call fails, that
  fire simply gets no summary (the alert still notifies normally) and the next
  fire retries.
- Silenced alerts are never investigated.

Dispatches are authenticated with the agent's own credential, and the agent
writes findings back to the API's internal listener
(`HYPERDX_INVESTIGATION_WRITEBACK_URL`, default
`http://localhost:8001/agent/investigations` — in Compose this is wired to the
`app` service automatically). The write-back is team-scoped and one-shot:
delivered summaries are immutable.

Environment variables (API / `app` service):

| Variable | Default | Purpose |
| --- | --- | --- |
| `AGENT_INVESTIGATIONS_ENABLED` | `false` | Master switch for auto-investigations |
| `AGENT_WORKFLOW_URL` | `http://agent:4010/workflows/investigateAlert` | Where the alert task dispatches fires |
| `AGENT_CREDENTIAL_ENDPOINT_ENABLED` | unset (`true` in Compose) | Serves the agent's credential + write-back on the internal listener |
| `AGENT_CREDENTIAL_PORT` | `8001` | Port of that internal listener (never publish it) |

For local dev outside Compose, run the API with
`AGENT_CREDENTIAL_ENDPOINT_ENABLED=true` so the credential fetch and the
write-back both work against `localhost:8001`.

Investigations assume the single-team model of self-hosted ClickStack (the
agent holds one team's credential); on a multi-team deployment only the first
team's alerts can be investigated.

## How it works

This is a standard [Flue](https://flue.dev) app: everything is discovered from
`src/` conventions and compiled into a single server by the `flue` CLI.

- `src/agents/assistant.ts`: the chat agent; the filename is the name, so it's
  served at `/agents/assistant/:id`
- `src/workflows/investigateAlert.ts`: the alert-investigation workflow, served
  at `/workflows/investigateAlert` (requires the agent credential as a Bearer
  token)
- `src/investigator.ts`: the shared read-only agent definition (model, tools,
  instructions) used by both the assistant and the workflow
- `src/mcp.ts`: credential resolution + MCP connection (the ClickStack tools)
- `src/db.ts`: SQLite persistence for conversations and workflow runs
- `src/app.ts`: custom routes (`/health`) composed with Flue's

Useful CLI commands:

```bash
yarn workspace @hyperdx/agent dev     # serve + watch (flue dev)
yarn workspace @hyperdx/agent build   # compile to dist/server.mjs (flue build)
yarn workspace @hyperdx/agent flue run assistant --input '{"message":"Say hi"}'  # one-shot prompt, no server needed
yarn workspace @hyperdx/agent flue docs                                          # browse Flue's bundled docs
```

## Docker Compose

The service is opt-in (`agent` profile) and bound to loopback only:

```bash
ANTHROPIC_API_KEY="..." docker compose --profile agent up -d --build agent
```

No ClickStack credential is needed: once you register an account in the app,
the agent fetches its own read-only credential from the API and connects.

The SQLite database lives in the `agent_data` volume. Override the host port
with `HYPERDX_AGENT_PORT` (default `4010`).
