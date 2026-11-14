# Documentation index

| Path | Contents |
|---|---|
| `README.md` (repo root) | user-facing overview, quick start, requirements, maps |
| [`arch/overview.md`](arch/overview.md) | architecture: components, network surface, a session's life |
| [`arch/decisions.md`](arch/decisions.md) | the *why* of the major decisions and their consequences |
| [`arch/protocol.md`](arch/protocol.md) | realtime protocol message catalogue + call semantics |
| [`arch/client.md`](arch/client.md) | the web client: rendering, movement, realtime, layout |
| [`arch/moq-sfu.md`](arch/moq-sfu.md) | the MoQ SFU media architecture: media model, fan-out, tickets, client pipelines |
| [`arch/moq-spike-results.md`](arch/moq-spike-results.md) | historical transport measurements that shaped the SFU's tuning |
| [`dev/README.md`](dev/README.md) | developing: prerequisites, dev loop, `just` tasks, repository layout |
| [`dev/testing.md`](dev/testing.md) | test suites: unit, integration, E2E, load — and how to run them |
| [`ops/README.md`](ops/README.md) | deployment/administration: Docker, Helm, TLS, auth, metrics, logs, limits |
| [`ops/maps.md`](ops/maps.md) | building maps with Tiled: ids, zones, collision, starter kit |
| [`../deploy/helm/campfire/README.md`](../deploy/helm/campfire/README.md) | the Helm chart: values, requirements, TLS notes |
| [`../CHANGELOG.md`](../CHANGELOG.md) | release history |

Docs are written for humans **and** agents: every file is self-contained,
references other files by repo-root-relative path, and avoids section numbers
whose anchors go stale (link by file and heading instead).
