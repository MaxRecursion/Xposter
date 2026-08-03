# Xposter Observability Setup (Mac mini)

This guide walks through setting up a **local, end-to-end observability stack** for Xposter on a Mac mini. The stack uses:

| Component | Role |
|---|---|
| **OpenTelemetry Collector** | Receives OTLP traces, metrics, and logs from Xposter |
| **Grafana Tempo** | Stores distributed traces |
| **Grafana Loki** | Stores structured logs |
| **Prometheus** | Stores metrics (scraped from the collector + Tempo span metrics) |
| **Grafana** | Dashboards, log ↔ trace correlation, service map |

Xposter itself stays a **native Node.js process** (launchctl / `npm start`). Only the observability backends run in Docker.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Mac mini (host)                                                │
│                                                                 │
│  ┌──────────────────┐    OTLP HTTP :4318    ┌─────────────────┐ │
│  │  Xposter         │ ───────────────────► │ OTEL Collector  │ │
│  │  (launchctl /    │   traces/metrics/logs │                 │ │
│  │   npm start)     │                       └────────┬────────┘ │
│  └──────────────────┘                                │          │
│                                                      │          │
│  ┌───────────────────────────────────────────────────┼────────┐ │
│  │ Docker (observability/docker-compose.yml)         │        │ │
│  │                                                   ▼        │ │
│  │   Tempo ◄── traces    Prometheus ◄── metrics    Loki ◄ logs│ │
│  │     │                      │                      │        │ │
│  │     └──────────────────────┴──────────────────────┘        │ │
│  │                            │                               │ │
│  │                       Grafana :3001                        │ │
│  └────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

**What gets instrumented automatically**

- HTTP/Express requests (latency, status codes)
- Outbound HTTP (Groq, Voyage, ntfy, RSS, etc.)
- Winston logs with `trace_id` / `span_id` correlation
- Custom metrics: `xposter.pipeline.*`, `xposter.scheduler.*`
- Custom spans: `pipeline.reply.run`, `scheduler.*`

---

## Prerequisites

Install these on the Mac mini before starting:

### 1. Docker Desktop

```bash
# Verify Docker is running
docker --version
docker compose version
```

Download from https://www.docker.com/products/docker-desktop/ if needed. Allocate at least **4 GB RAM** to Docker in Docker Desktop → Settings → Resources.

### 2. Node.js 22+

Xposter already uses Node 22. Verify:

```bash
node --version   # v22.x recommended
npm --version
```

### 3. Xposter repo

```bash
cd ~/path/to/Xposter   # adjust to your clone location
npm run setup
npm run build
```

---

## Step 1 — Start the observability stack

From the Xposter repo root:

```bash
npm run obs:up
```

This starts five containers:

| Service | Host port | Purpose |
|---|---|---|
| OTEL Collector | 4317 (gRPC), **4318 (HTTP)**, 8889, 13133 | OTLP ingest + health |
| Grafana | **3001** | Dashboards (login: `admin` / `admin`) |
| Prometheus | 9090 | Metrics query API |
| Loki | 3100 | Log store |
| Tempo | 3200 | Trace store |

**Verify containers are healthy:**

```bash
npm run obs:status
```

Expected: all services `running`. Then check collector health:

```bash
curl -s http://127.0.0.1:13133/
```

You should see `Server available`.

**View stack logs (if something fails):**

```bash
npm run obs:logs
```

**Stop the stack:**

```bash
npm run obs:down
```

Data persists in Docker volumes (`tempo-data`, `loki-data`, `prometheus-data`, `grafana-data`) across restarts.

---

## Step 2 — Enable OpenTelemetry in Xposter

Edit `.env` in the repo root:

```env
OTEL_ENABLED=true
OTEL_SERVICE_NAME=xposter
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
OTEL_TRACES_SAMPLER_ARG=1.0
LOG_LEVEL=info
```

| Variable | Description |
|---|---|
| `OTEL_ENABLED` | Master switch (`true` to export telemetry) |
| `OTEL_SERVICE_NAME` | Service name in Grafana (default `xposter`) |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Collector HTTP base URL (no `/v1/traces` suffix) |
| `OTEL_TRACES_SAMPLER_ARG` | Fraction of traces to keep (`1.0` = all; fine for local) |
| `LOG_LEVEL` | Winston level (`debug` for verbose local debugging) |

> **Important:** Telemetry is auto-disabled when `NODE_ENV=test` so Vitest runs stay clean.

Rebuild after `.env` changes if you run from `dist/`:

```bash
npm run build
```

---

## Step 3 — Run Xposter with instrumentation loaded

Telemetry must load **before** Express and HTTP modules. The `start` and `dev` scripts handle this via Node's `--import` flag.

### Development (foreground)

```bash
npm run dev
```

### Production (built)

```bash
npm run build
npm start
```

On startup you should see a log line like:

```
OpenTelemetry enabled {"endpoint":"http://127.0.0.1:4318","service":"xposter","started":true}
```

**Verify health endpoint:**

```bash
curl -s http://127.0.0.1:3000/health | python3 -m json.tool
```

Look for `"telemetry": { "enabled": true, "started": true, ... }`.

---

## Step 4 — Wire into launchctl (production Mac mini)

If Xposter runs as a launchd service, the plist must use the instrumented start command.

### Option A — npm start (recommended)

Ensure the plist `WorkingDirectory` points to the repo and `ProgramArguments` uses npm:

```xml
<key>ProgramArguments</key>
<array>
  <string>/usr/local/bin/npm</string>
  <string>start</string>
</array>
<key>WorkingDirectory</key>
<string>/Users/YOU/path/to/Xposter</string>
<key>EnvironmentVariables</key>
<dict>
  <key>OTEL_ENABLED</key>
  <string>true</string>
  <key>OTEL_EXPORTER_OTLP_ENDPOINT</key>
  <string>http://127.0.0.1:4318</string>
</dict>
```

Adjust the npm path (`which npm`).

### Option B — direct node invocation

```xml
<key>ProgramArguments</key>
<array>
  <string>/usr/local/bin/node</string>
  <string>--import</string>
  <string>./dist/telemetry/register.js</string>
  <string>dist/index.js</string>
</array>
```

### Reload launchd

```bash
launchctl stop com.akshay.xposter
sleep 4
launchctl start com.akshay.xposter
```

Check logs:

```bash
tail -f logs/xposter-$(date +%Y-%m-%d).log
```

---

## Step 5 — Open Grafana and explore

1. Open **http://localhost:3001**
2. Login: `admin` / `admin` (change password on first login)
3. Go to **Dashboards → Xposter → Xposter Overview**

The provisioned dashboard includes:

- HTTP request rate and p95 latency
- Reply pipeline run counts and duration
- Live log stream (`{service_name="xposter"}`)
- Recent traces (TraceQL)

### Explore logs (Loki)

1. **Explore** → datasource **Loki**
2. Query:

```logql
{service_name="xposter"} | json
```

3. Click a log line → **View trace** (if `trace_id` is present)

### Explore traces (Tempo)

1. **Explore** → datasource **Tempo**
2. Search: `{ resource.service.name = "xposter" }`
3. Open a trace → **Logs for this span** jumps to correlated Loki logs

### Explore metrics (Prometheus)

Useful queries:

```promql
# Pipeline runs per hour
sum(increase(xposter_pipeline_runs_total[1h])) by (source, outcome)

# Pipeline p95 duration
histogram_quantile(0.95, sum(rate(xposter_pipeline_duration_ms_bucket[5m])) by (le, source))

# HTTP request rate (auto-instrumentation)
sum(rate(http_server_duration_milliseconds_count{service_name="xposter"}[5m]))
```

---

## Step 6 — Generate traffic to validate

With Xposter running and the stack up:

```bash
# Liveness + telemetry status
curl http://127.0.0.1:3000/health

# Diagnostics (includes telemetry block)
curl http://127.0.0.1:3000/api/diagnostics

# Trigger a manual pipeline run (requires API_KEY in .env)
curl -X POST -H "x-api-key: YOUR_API_KEY" http://127.0.0.1:3000/api/run
```

Within ~30 seconds you should see:

- HTTP spans in Tempo
- Log lines in Loki with `trace_id`
- `xposter_pipeline_*` metrics in Prometheus/Grafana after the pipeline completes

---

## Troubleshooting

### Telemetry shows `started: false`

| Symptom | Fix |
|---|---|
| `OTEL_ENABLED` not `true` | Set in `.env`, restart Xposter |
| Missing endpoint | Set `OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318` |
| Collector not running | `npm run obs:up` and `curl http://127.0.0.1:13133/` |
| Started without `--import` | Use `npm start` or `npm run dev`, not bare `node dist/index.js` |

### No data in Grafana

1. Confirm collector is receiving data:

```bash
docker logs xposter-otel-collector --tail 50
```

2. Confirm Xposter can reach the collector:

```bash
curl -v http://127.0.0.1:4318/v1/traces
# Expect 405 or 400 — means the port is open; connection refused means collector is down
```

3. Check Prometheus targets: http://localhost:9090/targets — `otel-collector` should be **UP**.

### `npm run obs:up` fails (`docker: unknown command: docker compose` or `unknown shorthand flag: -f`)

Homebrew installs the Docker **CLI** separately from Docker Desktop. The Compose plugin is not always on your `PATH`.

1. Ensure a Docker engine is running (Docker Desktop, or [Colima](https://github.com/abiosoft/colima): `brew install colima docker docker-compose && colima start`).
2. Repo scripts use `scripts/obs-compose.sh`, which prefers `docker compose` and falls back to `docker-compose`.
3. If you use only Homebrew's `docker` formula, also run `brew install docker-compose`.

### Tempo container restart loop (`permission denied` on `/tmp/tempo`)

Tempo 2.7+ runs as a non-root user. Mount the data volume at `/var/tempo` (see `observability/tempo/tempo.yaml`). After updating, recreate the stack:

```bash
npm run obs:down
docker volume rm xposter-observability_tempo-data 2>/dev/null || true
npm run obs:up
```

### Docker port conflicts

If port 3001 is taken, edit `observability/docker-compose.yml`:

```yaml
grafana:
  ports:
    - "3002:3000"   # use 3002 instead
```

Then open http://localhost:3002.

### High disk usage

Retention defaults to **7 days** (Loki/Tempo configs). To prune Docker volumes entirely:

```bash
npm run obs:down
docker volume rm xposter-observability_tempo-data xposter-observability_loki-data \
  xposter-observability_prometheus-data xposter-observability_grafana-data
```

### launchctl starts before Docker

If Xposter boots at login before Docker Desktop, telemetry export will fail silently until the collector is up. Options:

1. Set Docker Desktop to start at login
2. Add a `LaunchAgents` dependency or a wrapper script that waits for port 4318
3. Use `OTEL_ENABLED=false` until Docker is ready, then restart Xposter

Example wait script (`scripts/wait-for-otel.sh`):

```bash
#!/bin/bash
for i in $(seq 1 30); do
  curl -sf http://127.0.0.1:13133/ >/dev/null && exit 0
  sleep 2
done
echo "OTEL collector not ready after 60s" >&2
exit 1
```

---

## File reference

| Path | Purpose |
|---|---|
| `observability/docker-compose.yml` | Full LGTM stack definition |
| `observability/otel-collector/config.yaml` | OTLP → Tempo/Loki/Prometheus routing |
| `observability/grafana/` | Provisioned datasources + dashboards |
| `src/telemetry/register.ts` | Node `--import` entry (loads before app) |
| `src/telemetry/bootstrap.ts` | SDK init, exporters, auto-instrumentation |
| `src/telemetry/metrics.ts` | Custom pipeline/scheduler metrics |
| `src/telemetry/instrument.ts` | Span helpers used by pipeline |
| `src/utils/logger.ts` | Winston + trace_id injection |

---

## npm scripts cheat sheet

| Command | Action |
|---|---|
| `npm run obs:up` | Start observability stack |
| `npm run obs:down` | Stop stack |
| `npm run obs:status` | Container status |
| `npm run obs:logs` | Tail all container logs |
| `npm run dev` | Xposter with OTEL (dev) |
| `npm start` | Xposter with OTEL (production build) |

---

## Security notes (local Mac mini)

- Grafana defaults to `admin`/`admin` — **change on first login**
- Observability ports bind to localhost by default via Docker port mapping; do not expose 3001/9090/4318 to the public internet without auth/TLS
- Logs may contain tweet text and API metadata — treat Loki data like application logs
- `.env` secrets are never exported to telemetry; only config *presence* flags appear in `/api/diagnostics`

---

## Quick start checklist (Claude / operator)

Copy-paste this sequence on the Mac mini:

```bash
# 1. Repo setup
cd ~/path/to/Xposter
npm run setup
npm run build

# 2. Start observability backends
npm run obs:up
curl -s http://127.0.0.1:13133/   # should succeed

# 3. Enable OTEL in .env
#    OTEL_ENABLED=true
#    OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318

# 4. Start Xposter
npm start
# or: launchctl start com.akshay.xposter

# 5. Validate
curl -s http://127.0.0.1:3000/health | python3 -m json.tool
open http://localhost:3001
```

When all steps pass, traces, metrics, and logs from Xposter flow into Grafana with log ↔ trace correlation.
