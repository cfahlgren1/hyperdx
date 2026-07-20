# @hyperdx/agent

AI on-call agent for self-hosted ClickStack, built on [Flue](https://flue.dev).
When an alert fires, it investigates the underlying telemetry and posts a
root-cause summary under **Alerts → Investigations**. The same read-only
investigator is also available as a durable conversational agent over HTTP.

## Quick start

```bash
ANTHROPIC_API_KEY="..." AGENT_INVESTIGATIONS_ENABLED=true \
  docker compose --profile agent up -d
```

Once an account exists in the app, the agent provisions its own read-only
ClickStack credential and starts investigating fresh alert fires.

## How investigations behave

- One investigation per fresh fire (the OK→ALERT edge) — never per tick of a
  sustained breach, never for silenced alerts.
- Cost-capped: at most one per alert per hour, 5 per evaluation for grouped
  alerts, 10 per task run.
- At-most-once: if the agent or model fails, that fire just gets no summary; the
  alert still notifies normally.
- Read-only: the credential is server-enforced, queries are attributed in the
  ClickHouse query log, and every agent endpoint requires it. The agent
  recommends fixes, never applies them.

Assumes the single-team model of self-hosted ClickStack.

## Talking to the investigator

```bash
npx flue-tui investigator --server http://127.0.0.1:4010 --token $YOUR_API_KEY
```

Authenticate with your personal ClickStack API key (Team Settings → API Keys).
Conversations live at `/agents/investigator/:conversationId` and are durable —
the same ID resumes the same thread.

<details>
<summary>Plain HTTP</summary>

`?wait=result` blocks for the answer; omit it to stream; `POST .../abort`
cancels.

```bash
curl -X POST \
  'http://127.0.0.1:4010/agents/investigator/local-operator?wait=result' \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $YOUR_API_KEY" \
  -d '{"message":"Which services produced the most errors in the last hour?"}'
```

</details>

## Memory

Every session runs in a sandbox seeded with the deployment's durable context:

```text
/workspace
├── investigations/   # past reports, one per case
└── memory/           # durable notes the agent keeps
```

Alert runs sync new or edited `memory/` files back after each run; conversations
save notes with an `update_memory` tool. Capped at 10 files × 4KB, editable in
**Settings → Investigation Agent** (team instructions live there too).

## Choosing a model

The default is `claude-sonnet-5`. Override with `AI_MODEL_NAME`:

| To use                    | Set                                                                    |
| ------------------------- | ---------------------------------------------------------------------- |
| Another Anthropic model   | `AI_MODEL_NAME=claude-opus-4-8`                                        |
| Anthropic-compatible host | `ANTHROPIC_BASE_URL=...`                                               |
| OpenAI                    | `AI_MODEL_NAME=openai/gpt-5.4` + `OPENAI_API_KEY`                      |
| OpenRouter                | `AI_MODEL_NAME=openrouter/deepseek/deepseek-r1` + `OPENROUTER_API_KEY` |
| Vercel AI Gateway         | `AI_MODEL_NAME=gateway/zai/glm-4.7` + `AI_GATEWAY_API_KEY`             |

A bare model name keeps the `anthropic/` default.

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

Run the API with `AGENT_INVESTIGATIONS_ENABLED=true`.

<details>
<summary>Trigger an investigation manually</summary>

Authenticate with the agent's provisioned credential (the same one the agent
fetches at startup):

```bash
CRED=$(curl -s -H 'x-hyperdx-agent-provision: 1' \
  http://127.0.0.1:8001/agent/credential | jq -r .credential)
curl -X POST 'http://127.0.0.1:4010/workflows/investigateAlert?wait=result' \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $CRED" \
  -d '{"alertHistoryId":"<id>","alertId":"<id>"}'
```

</details>

Workflow runs persist to SQLite: the `agent_data` volume in Compose,
`.volumes/agent/` in local dev (override with `FLUE_DB_PATH`).

## Architecture

![Architecture: triggers feed the Flue agent sidecar, which investigates through the read-only ClickStack MCP server and produces an investigation result](https://raw.githubusercontent.com/cfahlgren1/hyperdx/assets/agent-architecture/agent-architecture.png)
