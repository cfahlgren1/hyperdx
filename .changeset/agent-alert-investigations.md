---
"@hyperdx/api": minor
---

feat(agent): trigger an on-call agent investigation when an alert fires. On the OK/PENDING -> ALERT edge (once per fire, not per breaching tick), the alert task marks the AlertHistory record and the alert provider fire-and-forgets a request to the agent's `investigateAlert` workflow. The agent investigates via its read-only MCP tools and posts a findings summary back to a new team-scoped, credential-authenticated internal endpoint (`POST /agent/investigations`), which stores it on the AlertHistory doc (`investigation.summary` — surfacing it in the alert UI is a planned follow-up). Gated by `AGENT_INVESTIGATIONS_ENABLED` (default off); delivery is at-most-once by design.
