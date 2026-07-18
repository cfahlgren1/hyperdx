# @hyperdx/agent

AI on-call agent for self-hosted ClickStack, built on [Flue](https://flue.dev).
When an alert fires, it investigates the underlying telemetry through
ClickStack's MCP server and posts a root-cause summary, shown in the app under
**Alerts → Investigations**. The same read-only investigator is also available
as a durable conversational agent over Flue's HTTP API.

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

## Talk to the investigator

The investigator is exposed at `/agents/investigator/:conversationId` —
conversations are durable, so the same ID resumes the same thread.
Authenticate with your personal ClickStack API key (Team Settings → API Keys);
the installation credential also works for internal callers.

```bash
npx flue-tui investigator --server http://127.0.0.1:4010 --token $YOUR_API_KEY
```

Or over plain HTTP (`?wait=result` blocks for the answer; omit it to stream;
`POST .../abort` cancels):

```bash
curl -X POST \
  'http://127.0.0.1:4010/agents/investigator/local-operator?wait=result' \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $YOUR_API_KEY" \
  -d '{"message":"Which services produced the most errors in the last hour?"}'
```

Every session — conversational or alert-triggered — works in a sandbox seeded
with the deployment's durable context, which the agent can grep and read:

```text
/workspace
├── investigations/                        # past reports, one per case
│   ├── 2026-07-16-checkout-errors.md
│   └── 2026-07-18-clickhouse-server-errors.md
└── memory/                                # durable notes the agent keeps
    ├── README.md
    └── checkout-service.md
```

Alert investigations sync new or edited `memory/` files back to ClickStack
after each run; conversations save notes with an `update_memory` tool. Both
are capped at 10 files x 4KB and correctable in Settings -> AI Agent, where
team instructions also live.

With `GITHUB_TOKEN` set (and optionally `GITHUB_REPO` as an `owner/repo`
default), the investigator can also search and read GitHub issues while
investigating; in conversations it can additionally file an issue when you
ask it to.

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
