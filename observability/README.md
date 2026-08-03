# Xposter local observability stack

Docker Compose services for Grafana, Loki, Prometheus, Tempo, and the OpenTelemetry Collector.

**Setup guide:** [docs/OBSERVABILITY_SETUP.md](../docs/OBSERVABILITY_SETUP.md)

```bash
# From repo root
npm run obs:up
npm run obs:status
npm run obs:logs
npm run obs:down
```

Grafana: http://localhost:3001 (default `admin` / `admin`)
