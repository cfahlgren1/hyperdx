# @hyperdx/agent

AI on-call agent for self-hosted ClickStack, built on [Flue](https://flue.dev).
When an alert fires, it investigates the underlying telemetry through
ClickStack's MCP server and posts a root-cause summary, shown in the app under
**Alerts → Investigations**. The same read-only assistant is also available as
a durable conversational agent over Flue's HTTP API.

## Quick start

```bash
ANTHROPIC_API_KEY="..." AGENT_INVESTIGATIONS_ENABLED=true \
  docker compose --profile agent up -d
```

Once an account is registered in the app, the agent provisions its own read-only
ClickStack credential and starts investigating fresh alert fires. Override the
model with `AI_MODEL_NAME` (default `claude-sonnet-5`), or point
`ANTHROPIC_BASE_URL` at any Anthropic-compatible endpoint.

## How investigations behave

- One investigation per fresh fire (the OK→ALERT edge) — never per tick of a
  sustained breach, never for silenced alerts.
- Cost-capped: at most one per alert per hour, 5 per evaluation for grouped
  alerts, 10 per task run.
- At-most-once: if the agent or model fails, that fire just gets no summary —
  the alert still notifies normally.
- The agent's credential is server-enforced read-only, its ClickHouse queries
  are attributed in the query log, and every agent endpoint requires that
  credential.

Assumes the single-team model of self-hosted ClickStack.

## Talk to the assistant

The assistant is exposed at `/agents/assistant/:conversationId`. Reuse a stable
conversation ID to continue the same durable conversation; use a new ID to
start with fresh context. Every assistant route requires the provisioned agent
credential and uses the same server-enforced read-only ClickStack tools as
automatic investigations.

```bash
CRED=$(curl -s -H 'x-hyperdx-agent-provision: 1' \
  http://127.0.0.1:8001/agent/credential | jq -r .credential)

curl -X POST \
  'http://127.0.0.1:4010/agents/assistant/local-operator?wait=result' \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $CRED" \
  -d '{"message":"Which services produced the most errors in the last hour?"}'
```

Omit `?wait=result` to receive stream coordinates immediately, then read the
durable conversation from the returned `streamUrl`. `POST
/agents/assistant/:conversationId/abort` cancels in-flight work for that
conversation.

## Configuration

Set on the `app` service:

| Variable                       | Default                                        |                                                            |
| ------------------------------ | ---------------------------------------------- | ---------------------------------------------------------- |
| `AGENT_INVESTIGATIONS_ENABLED` | `false`                                        | master switch                                              |
| `AGENT_WORKFLOW_URL`           | `http://agent:4010/workflows/investigateAlert` | dispatch target                                            |
| `AGENT_CREDENTIAL_PORT`        | `8001`                                         | internal credential/write-back listener — never publish it |

## Local development

```bash
yarn workspace @hyperdx/agent dev
```

Run the API with `AGENT_INVESTIGATIONS_ENABLED=true`. To trigger an
investigation manually, authenticate with the agent's provisioned credential
(the same one the agent fetches at startup):

```bash
CRED=$(curl -s -H 'x-hyperdx-agent-provision: 1' \
  http://127.0.0.1:8001/agent/credential | jq -r .credential)
curl -X POST 'http://127.0.0.1:4010/workflows/investigateAlert?wait=result' \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $CRED" \
  -d '{"alertHistoryId":"<id>","alertId":"<id>"}'
```

Workflow runs persist to SQLite: the `agent_data` volume in Compose,
`.volumes/agent/` in local dev (override with `FLUE_DB_PATH`).
