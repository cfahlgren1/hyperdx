---
"@hyperdx/app": minor
---

feat(alerts): add an Investigations tab to the alerts page showing AI
investigation reports from the on-call agent. Each entry shows the alert, when
it fired, a one-line probable-cause gist, and how long the investigation took,
and expands to the full markdown findings with a link to the underlying data.
Backed by `GET /alerts/investigations` so summaries stay reachable after they
scroll out of the per-alert chart history.
