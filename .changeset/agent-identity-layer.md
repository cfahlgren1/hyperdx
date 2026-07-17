---
'@hyperdx/api': minor
---

Add zero-config provisioning for a team-scoped, read-only agent MCP credential: a new AgentInstallation model, an hdx_agent_* credential type resolved to a read-only MCP principal, and an internal-only credential listener gated behind AGENT_INVESTIGATIONS_ENABLED.
