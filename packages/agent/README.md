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

The assistant queries ClickStack through the API's MCP server with a read-only
tool allowlist (search, SQL, traces, dashboards/alerts reads, no writes). Set
`HYPERDX_MCP_ACCESS_KEY` to a personal API access key from Team Settings; all
conversations query as that key's user and team. The MCP server defaults to
`http://localhost:8000/mcp` (override with `HYPERDX_MCP_URL`).

## How it works

This is a standard [Flue](https://flue.dev) app: everything is discovered from
`src/` conventions and compiled into a single server by the `flue` CLI.

- `src/agents/assistant.ts`: the agent; the filename is the name, so it's served
  at `/agents/assistant/:id`
- `src/db.ts`: SQLite persistence for conversations
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

The SQLite database lives in the `agent_data` volume. Override the host port
with `HYPERDX_AGENT_PORT` (default `4010`).
