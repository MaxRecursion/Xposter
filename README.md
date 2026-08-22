# Xposter

A personal X/Twitter automation system for Pune-based operators. Xposter runs locally on macOS, ingests your home timeline via Playwright, scores and filters tweets, generates AI-powered replies with Groq, posts automatically, and publishes 7 original posts per day — all with real-time iPhone notifications via ntfy.

Built with TypeScript, SQLite, Playwright stealth, Voyage AI embeddings for RAG, and an optional Claude-powered self-healing agent.

---

## Table of Contents

1. [What It Does](#what-it-does)
2. [Architecture](#architecture)
3. [Features](#features)
4. [Setup & Installation](#setup--installation)
5. [Configuration Reference](#configuration-reference)
6. [API Reference](#api-reference)
7. [Scheduler Overview](#scheduler-overview)
8. [Dashboard Overview](#dashboard-overview)
9. [Database Schema](#database-schema)
10. [Context / RAG System](#context--rag-system)
11. [Claude Agent (Self-Healing)](#claude-agent-self-healing)
12. [Tech Stack](#tech-stack)

---

## What It Does

Xposter runs five things on a schedule:

| Job | What happens |
|---|---|
| **Reply pipeline** (5×/day) | Playwright scrapes timeline and/or trends → filters → scores (including conversation opportunity + velocity) → generates English replies (Conversation Gravity + 20% Reply Tournament) → ntfy or auto-posts |
| **Original posts** (7×/day) | Picks topic weighted by RAG trends → gathers research context → drafts via Groq → posts to your timeline |
| **Follower sync** (periodic) | Detects new followers → ntfy alert with one-tap "Follow Back / Skip" |
| **Impression sync** (every 2 h) | Playwright scrapes likes/replies/retweets/impressions for recent originals → stores for dashboard charting |
| **Audience heatmap** (periodic) | Scrapes a 7×24 activity matrix of your followers → biases post times toward high-engagement hours |

Everything is controlled from a local web dashboard backed by a single SQLite database.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  Mac (runs 24/7)                                                 │
│                                                                  │
│  ┌────────────────┐   ┌──────────────────────────────────────┐  │
│  │  Express :3000 │   │  Scheduler                           │  │
│  │  ├─ REST /api  │   │  ├─ random_runs.ts   (5×/day reply)  │  │
│  │  └─ SPA        │   │  ├─ original_posts.ts (7×/day OG)    │  │
│  └───────┬────────┘   │  ├─ follower_sync.ts                 │  │
│          │            │  ├─ audience_sync.ts                  │  │
│          │            │  └─ context/ingest/scheduler.ts       │  │
│          │            └──────────────┬───────────────────────┘  │
│          │                           │                           │
│          │     ┌─────────────────────▼──────────────────────┐   │
│          │     │  Reply Pipeline (reply_pipeline.ts)         │   │
│          │     │  1. ingestTimeline()  — Playwright scroll   │   │
│          │     │  2. filterPost()      — language+keywords   │   │
│          │     │  3. scorePost()       — 0-100 composite     │   │
│          │     │  4. classifyAccount() — heuristic→Groq LLM  │   │
│          │     │  5. generateReply()   — Groq, topic brain,  │   │
│          │     │     Gravity critic, 20% Tournament          │   │
│          │     │  6. postReply()       — Playwright post     │   │
│          │     │  7. ntfy notification — approve/skip        │   │
│          │     └────────────────────────────────────────────-┘   │
│          │                                                        │
│          │     ┌──────────────────────────────────────────────┐  │
│          │     │  Original Post Pipeline                      │  │
│          │     │  1. generateRandomSlots() — jittered grid    │  │
│          │     │  2. pickTopicAndCategory()— trend-weighted   │  │
│          │     │  3. gatherResearchContext()                   │  │
│          │     │  4. generateOriginalPost() — Groq + quality  │  │
│          │     │  5. postOriginalTweet()   — Playwright       │  │
│          │     │  6. impressionSync() every 2h                │  │
│          │     └──────────────────────────────────────────────┘  │
│          │                                                        │
│          │     ┌──────────────────────────────────────────────┐  │
│          │     │  Intelligence Layers                         │  │
│          │     │  ├─ topic_graph.ts / brain.ts (linked topics)│  │
│          │     │  ├─ neural_memory.ts  (concept graph)        │  │
│          │     │  ├─ store/store.ts    (Voyage + sqlite-vec)  │  │
│          │     │  ├─ retrieve/retriever.ts (linked-topic rank)│  │
│          │     │  └─ sources: Pune civic · India work · AI    │  │
│          │     └──────────────────────────────────────────────┘  │
│          │                                                        │
│          │     ┌──────────────────────────────────────────────┐  │
│          │     │  Agent (optional, agent/)                    │  │
│          │     │  ├─ watcher.ts  — polls activity_log         │  │
│          │     │  ├─ investigator.ts — Claude Code analysis   │  │
│          │     │  └─ implementer.ts — codes fix, opens PR     │  │
│          │     └──────────────────────────────────────────────┘  │
│          │                                                        │
│          │     ┌──────────────────────────────────────────────┐  │
│          │     │  SQLite WAL  data/xposter.db                 │  │
│          │     │  posts · accounts · interactions · settings  │  │
│          │     │  original_posts · context_items · vec_context│  │
│          │     │  activity_log · follower_events · audience   │  │
│          │     └──────────────────────────────────────────────┘  │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
       │                              │
  iPhone (Safari / Tailscale)    ntfy app
  Dashboard (Queue, RAG, Analytics, Mind, …)     Push alerts + action buttons
```

### End-to-End Data Flows

**Tweet ingestion → reply posting:**
```
Playwright scrolls home timeline (up to 40 tweets)
  → upsertPost()             status: INGESTED
  → filterPost()             language detection + keyword match → FILTERED or dropped
  → scorePost()              recency(0-30) + topic(0-30) + opportunity(0-20) + engagement(0-10) → SCORED
  → top-N candidates         (max_candidates_per_run, default 3; min_score threshold, default 40)
  → classifyAccount()        heuristic fast-path OR Groq 9-class LLM; 7-day cache
  → generateReply()          English-only draft:
                             [TOPIC BRAIN] linked topics (traffic → metro, civic, …)
                             [CURRENT CONTEXT] Voyage ANN + linked-topic re-rank
                             [LEARNED MEMORY] neural concept graph
                             Conversation Gravity (skip if too generic)
                             20% Reply Tournament (one-liner / second-order / receipt)
                             Groq (openai/gpt-oss-120b) with Claude CLI circuit-break
                             status: PENDING_APPROVAL or auto POSTING
  → ntfy push notification   signed approve/skip action URLs (HMAC, TTL-bound)
                             two empty scheduled runs → one stalled-delivery alert
  → user taps Approve        (or require_approval=false auto-posts)
  → postReply()              Playwright navigates tweet URL, submits reply
  → recordInteraction()      status: POSTED
  → ntfy confirmation
```

**Original post flow:**
```
generateRandomSlots() — Fisher-Yates shuffle over 7 jittered slots (09:00–22:00)
  → at each slot:
    pickTopicAndCategory()   weighted by trend velocity + past performance + recency penalty
    gatherResearchContext()  neural memory recall + context RAG retrieval
    generateOriginalPost()   Groq draft, quality gate, 280-char enforcement (2 retries)
    postOriginalTweet()      Playwright compose box
    insertOriginalPost()
  → every 2 h:
    scrapeEngagement()       Playwright scrapes likes/replies/retweets/impressions
    insertImpression()
```

**Follow-back flow:**
```
follower_sync scrapes follower list via Playwright
  → detect new handles not seen before
  → insert follower_events (status: PENDING)
  → sendFollowerNotification() — ntfy push with Follow Back / Skip action buttons
  → user taps on iPhone
  → follow_back_processor executes follow,
    respects max_follow_backs_per_day + blocklist_classifications
```

**Audience heatmap flow:**
```
audience_sync (periodic) scrapes follower activity page via Playwright
  → parse 7×24 activity matrix
  → store in audience table (cells_json)
  → audience_weights.ts applies matrix to bias scheduler toward high-engagement slots
```

**Context RAG ingestion:**
```
Default brain sources only (Pune civic, India jobs/economy, AI-as-work).
World/gadget/space feeds are opt-in via env.
For each active source:
  fetch items
  → SHA-256 dedup (drop exact duplicates before embedding)
  → batch Voyage embed (voyage-3-lite, 512 dim)
  → cosine near-duplicate filter (dist < 0.06 against recent 48h items → drop)
  → insert context_items + vec_context; tag topics; update corpus co-occurrence graph

On query (per reply/original-post generation):
  detect tweet topics → expand linked neighbors (static + corpus)
  embed query (+ related topics) via Voyage
  → vec0 KNN on vec_context (fetch k×3 candidates)
  → re-rank: similarity + recency + credibility + query/linked topic overlap
  → inject [TOPIC BRAIN] + [CURRENT CONTEXT] (Voyage optional; topic web always)
```

---

## Features

### Core Automation
- **Timeline ingestion** — Playwright stealth scrolls home timeline, extracts tweet_id, author, text, and engagement counts
- **Keyword + language filtering** — English tweets require a topic keyword match; Marathi/Devanagari posts can still be ingested. Generated replies are English-only.
- **Multi-factor scoring** — recency, topic relevance, reply opportunity, conversation opportunity, engagement sweet spot, velocity/reach, context-store topical heat, and prior account reply performance (including author come-back)
- **Account classification** — 9-class Groq LLM classifier (SERIOUS, NEWS, PARODY, COMEDY, INFLUENCER, REGULAR, BOT, BRAND_PROMO, UNKNOWN) with heuristic fast-path (PCF label, bot patterns, follower counts); 7-day TTL cache
- **Configurable approval queue** — optional PENDING_APPROVAL with one-tap Approve/Skip via ntfy (`require_approval`, default off / autonomous)
- **Conversation Gravity** — skip or rewrite drafts that would not earn a reply (heuristic 1–5 plus optional LLM judge)
- **Reply Tournament (20%)** — a controlled slice of candidates gets three distinct angles (one-liner, second-order, specific receipt); Gravity picks the winner; assignment is persisted
- **Original post generation** — 7 posts/day by default (4 ORIGINAL + 2 ENGAGEMENT_FARM + 1 QUOTE_TWEET); supports 2–3 post threads and trend-driven quote tweets
- **Engagement tracking** — scheduled syncs collect likes/replies/retweets/impressions for replies and originals; quality rate is actions per 1,000 impressions on metric-synced rows only

### Intelligence Layers
- **Dual persona** — Pune flavor (satirical Punekar: PMC, FC Road, Mula-Mutha, Hinjewadi) or General (sharp observer); auto-selected per tweet by content regex + topic tags
- **Wit level** — 0–100 slider maps to 5 tiers (SERIOUS → MEASURED → BALANCED → WITTY → SHARP); controls Groq temperature and system prompt tone
- **Neural schema memory** — concept graph built from 220 recent posts/replies; co-occurrence edges weighted by recency × engagement; top events injected as `[LEARNED MEMORY]`
- **Topic brain** — linked-topic graph (traffic ↔ metro/civic, AI ↔ jobs/startups, …) plus co-occurrence from ingested RAG items; injected as `[TOPIC BRAIN]` on every reply even when Voyage is off
- **Context RAG** (optional, `CONTEXT_ENABLED=true`) — related RSS/Reddit/weather sources only by default (Pune civic, India work/economy, AI-as-work); Voyage + sqlite-vec ANN; re-ranked with linked-topic overlap; injected as `[CURRENT CONTEXT]`
- **Trend detection** — topic velocity (6 h vs 24 h event ratio) biases original post topic selection toward hot topics
- **Audience heatmap** — 7×24 follower activity matrix biases scheduler toward high-engagement time slots
- **Performance analytics** — follower growth, reply success by class/source, topic trends, posting hours, and Tournament vs control **actions per 1,000 impressions**

### Notifications (ntfy)
- Reply approval request with signed approve/skip URLs (HMAC, TTL-bound)
- Reply posted confirmation with tweet URL
- New follower alert with Follow Back / Skip action buttons
- Session-expiry and unfollow alerts
- Weekly performance digest with replies, approval rate, follower delta, top reply, and best topic
- Stalled-delivery alert after two consecutive scheduled runs with no posted reply or approval candidate
- Action mode: `view` (opens dashboard) or `http` (fires API silently from phone)

### Safety & Control
- **Approval gate** — optional; `require_approval` defaults false (autonomous posting)
- **Human-likeness gate** — reject/regenerate AI-slop and engagement-farm openers
- **Classification blocklist** — BOT and BRAND_PROMO skipped from follow-back by default
- **Duplicate guard** — regenerates or skips replies and original posts that are too similar to recent output
- **Posting retry queue** — retries transient compose failures once with a capped delay
- **Min reply interval** — configurable floor between posted replies
- **Pause/resume** — `system_running` toggle in dashboard header; all schedulers respect it
- **Session watchdog** — pauses schedulers and alerts when the X login expires
- **Expiry sweep** — pending approvals expire after `approval_timeout_min` (default 30 min)

### Developer Features
- **Live dashboard** — multi-tab SPA served by Express, auto-refreshing via polling
- **Live settings** — all operational parameters editable from Settings tab, no restart required
- **Activity log** — append-only event stream, queryable, shown in Console and History tabs
- **Diagnostic endpoint** — `/api/diagnostics` reports Groq model availability, Claude CLI auth circuit, connectivity, and config
- **Claude Agent** (optional) — watcher monitors activity log for recurring errors, spawns investigator agent (Claude Code CLI); proposed fix shown on dashboard; one-click implementer opens a PR in a fresh git worktree
- **SSE streaming** — agent run progress streamed to dashboard in real time

### Language Support
- Devanagari Marathi (23 script markers)
- Transliterated Roman Marathi (9 phonetic markers: ahe, ahet, hota, karto, jato, mala, tula, khup, paus)
- Hindi (17 Devanagari markers) — detected separately, filtered unless mixed with Marathi
- English replies only (Marathi/Hinglish drafts are rejected at generation)
- English tweets still require a topic keyword match to pass the ingest filter

---

## Setup & Installation

### Prerequisites
- Node.js 22+
- Google Chrome installed (the bot uses your system Chrome, not Playwright's bundled Chromium)
- A Groq API key ([console.groq.com](https://console.groq.com), free tier works)
- An X/Twitter account with `auth_token` + `ct0` cookies (obtained after first browser login)
- ntfy app on iPhone (optional but strongly recommended)

### Install

```bash
git clone <repo>
cd Xposter
npm run setup          # npm install + playwright install chromium + cp .env.example .env
```

### Configure

Edit `.env` — minimum required fields:

```env
GROQ_API_KEY=...          # from console.groq.com
X_AUTH_TOKEN=             # fill in after first browser login (step below)
X_CT0=                    # fill in after first browser login
API_KEY=                  # openssl rand -hex 32
NTFY_TOPIC=...            # hard-to-guess string; subscribe to it in the ntfy iOS app
```

### First Login (X Cookie Auth)

X blocks Playwright-driven login flows. Instead:

1. Set `BROWSER_HEADLESS=false` in `.env`
2. Run `npm run dev` — Chromium opens
3. Log in to x.com manually
4. Open DevTools → Application → Cookies → `https://x.com`
5. Copy `auth_token` → `X_AUTH_TOKEN`, copy `ct0` → `X_CT0` in `.env`
6. Set `BROWSER_HEADLESS=true`, restart

Cookies typically last ~1 year. Repeat this step if the bot stops posting.

### Run

```bash
# Development (hot reload)
npm run dev

# Production
npm run build
npm start
```

Dashboard: `http://localhost:3000`  
iPhone (same WiFi): LAN URL is logged on startup, e.g. `http://192.168.1.42:3000`  
iPhone (remote): install Tailscale on Mac + iPhone, set `CALLBACK_NETWORK=tailscale`

### Optional: Context RAG

```env
CONTEXT_ENABLED=true
VOYAGE_API_KEY=your_voyage_key   # voyage.ai; free tier = 50M tokens/month
# Default sources are a related brain (Pune civic, India work, AI-as-work).
# Blank geopolitics/gadget URLs in .env.example stay off unless you opt in.
```

### Optional: OpenTelemetry observability

Local Grafana + Loki + Prometheus + Tempo stack. See **[docs/OBSERVABILITY_SETUP.md](docs/OBSERVABILITY_SETUP.md)** for the full Mac mini setup guide.

```bash
npm run obs:up          # start Docker observability stack
```

```env
OTEL_ENABLED=true
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
```

Grafana: http://localhost:3001 (default `admin` / `admin`)

### Optional: Claude Agent

Requires `claude` CLI and `gh` CLI in PATH.

```env
AGENT_ENABLED=true
AGENT_MODEL=claude-sonnet-4-5
```

---

## Configuration Reference

### Server

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Dashboard / API port |
| `HOST` | `0.0.0.0` | Bind address |
| `NODE_ENV` | `development` | Environment flag |
| `API_KEY` | — | Secret for all mutation endpoints. Generate: `openssl rand -hex 32` |
| `TRUST_DASHBOARD_ORIGIN` | `true` | Trust same-LAN origins without API key |

### Browser / X Auth

| Variable | Default | Description |
|---|---|---|
| `BROWSER_HEADLESS` | `true` | Set `false` to see the Chrome window during debugging |
| `BROWSER_USER_DATA_DIR` | `./browser-profile` | Playwright persistent context directory |
| `X_AUTH_TOKEN` | **required** | X `auth_token` cookie value |
| `X_CT0` | **required** | X `ct0` CSRF cookie value |

### LLM (Groq)

| Variable | Default | Description |
|---|---|---|
| `GROQ_API_KEY` | **required** | Groq API key |
| `GROQ_MODEL` | `openai/gpt-oss-120b` | Model for reply + original post generation |
| `LOG_PROMPTS` | `true` | Print full prompts to stdout |
| `LOG_LEVEL` | `info` | Winston log level (`error`/`warn`/`info`/`http`/`debug`) |
| `OTEL_ENABLED` | `false` | Export traces, metrics, and logs via OpenTelemetry |
| `OTEL_SERVICE_NAME` | `xposter` | Service name in Grafana/Tempo |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | — | OTLP HTTP collector URL (e.g. `http://127.0.0.1:4318`) |
| `OTEL_TRACES_SAMPLER_ARG` | `1.0` | Trace sampling ratio (0.0–1.0) |

### Scheduler

| Variable | Default | Description |
|---|---|---|
| `MAX_CANDIDATES_PER_RUN` | `3` | Max replies generated per pipeline run |
| `APPROVAL_TIMEOUT_MINUTES` | `30` | Minutes before PENDING_APPROVAL auto-expires |
| `MIN_REPLY_INTERVAL_SECONDS` | `300` | Minimum seconds between posted replies |
| `ACTION_TOKEN_TTL_SECONDS` | `86400` | ntfy action URL validity window |

### Notifications (ntfy)

| Variable | Default | Description |
|---|---|---|
| `NTFY_TOPIC` | **required** | Topic name (acts as shared secret) |
| `NTFY_SERVER` | `https://ntfy.sh` | ntfy server URL; use self-hosted for privacy |
| `NTFY_ACTION_MODE` | `view` | `view` = open dashboard in browser; `http` = fire API directly from phone |
| `CALLBACK_NETWORK` | `lan` | `lan` or `tailscale` — network used to build ntfy callback URLs |
| `CALLBACK_BASE_URL` | auto-detected | Override callback base URL |
| `TAILSCALE_IP` | auto-detected | Override Tailscale IP if auto-detection fails |

### Filtering

| Variable | Default | Description |
|---|---|---|
| `TOPIC_KEYWORDS` | `pune,rain,traffic,…` | Comma-separated keywords English tweets must match |
| `MIN_SCORE` | `40` | Minimum score (0–100) for a tweet to be a candidate |

### Context / RAG (optional)

| Variable | Default | Description |
|---|---|---|
| `CONTEXT_ENABLED` | `false` | Master switch for Voyage RAG retrieval (topic brain still runs without it) |
| `VOYAGE_API_KEY` | required if enabled | Voyage AI API key |
| `VOYAGE_DIM` | `512` | Embedding dimension (256/512/1024). Changing requires dropping `vec_context` |
| `VOYAGE_RPM` | `2.7` | Rate limit cap (requests/min). Free tier is 3 RPM |
| `CONTEXT_INGEST_INTERVAL_MIN` | per-source defaults | Override polling interval for all sources |
| `CONTEXT_RSS_*` | brain feeds | Override RSS URLs; `""` disables. Geopolitics/gadgets/space are opt-in |
| `CONTEXT_REDDIT_PUNE` | `pune` | Subreddit for Pune posts |
| `CONTEXT_REDDIT_INDIA` | off by default | Set to `india` to opt in (too broad for the default brain) |
| `CONTEXT_REDDIT_STARTUPS` | `startups` | Subreddit for startup posts |
| `CONTEXT_WEATHER_PUNE` | `Pune` | wttr.in location string |

### Claude Agent (optional)

| Variable | Default | Description |
|---|---|---|
| `AGENT_ENABLED` | `true` | Infrastructure kill switch (also toggleable from dashboard) |
| `AGENT_MODEL` | `claude-sonnet-4-5` | Claude model for agent runs |
| `AGENT_MAX_RUNS_PER_DAY` | `10` | Daily cap on agent invocations |
| `AGENT_INVESTIGATOR_MAX_TURNS` | `30` | Max turns for the investigator agent |
| `AGENT_IMPLEMENTER_MAX_TURNS` | `60` | Max turns for the implementer agent |
| `AGENT_WATCH_INTERVAL_MS` | `300000` | Watcher poll interval (5 min default) |
| `AGENT_DISALLOWED_PATHS` | — | Comma-separated paths the agent cannot read or modify |
| `AGENT_ALLOW_WEB` | `false` | Enable WebFetch/WebSearch for the agent |
| `AGENT_BASE_BRANCH` | `main` | Branch implementer opens PRs against |

### Live Settings (Dashboard → Settings Tab)

Stored in the `settings` table; take effect immediately without restart.

| Key | Type | Default | Range |
|---|---|---|---|
| `system_running` | bool | `true` | — |
| `wit_level` | int | `55` | 0–100 |
| `topic_keywords` | string | `pune,rain,…` | comma list |
| `min_score` | int | `40` | 0–100 |
| `max_candidates_per_run` | int | `3` | 1–10 |
| `require_approval` | bool | `false` | — |
| `approval_timeout_min` | int | `30` | 5–1440 |
| `random_runs_per_day` | int | `5` | 1–12 |
| `active_window_start_hour` | int | `9` | 0–23 |
| `active_window_end_hour` | int | `22` | 1–24 |
| `classification_ttl_days` | int | `7` | 1–90 |
| `blocklist_classifications` | string | `BOT,BRAND_PROMO` | comma list |
| `max_follow_backs_per_day` | int | `15` | 0–100 |
| `auto_follow_back_enabled` | bool | `false` | — |
| `auto_follow_back_classifications` | string | `REGULAR,SERIOUS` | comma list |
| `auto_follow_back_min_confidence` | int | `60` | 0–100 |
| `original_posts_per_day` | int | `7` | 1–12 |
| `engagement_bait_pct` | int | `15` | 0–100 |
| `conversation_gravity_min` | int | `3` | 1–5 |
| `conversation_gravity_judge` | bool | `true` | — |
| `reply_tournament_enabled` | bool | `true` | — |
| `reply_tournament_rollout_pct` | int | `20` | 0–100 |
| `weekly_digest_enabled` | bool | `true` | — |
| `weekly_digest_hour` | int | `9` | 0–23 |
| `agent_enabled` | bool | `false` | — |
| `agent_error_threshold` | int | `3` | 1–50 |

---

## API Reference

All mutation endpoints require `X-API-Key` header matching `API_KEY` in `.env`. Read endpoints are accessible from the local network without a key (controlled by `TRUST_DASHBOARD_ORIGIN`).

### System

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | System health check |
| `GET` | `/api/diagnostics` | Groq model availability, Claude CLI auth circuit, config |
| `POST` | `/api/run` | Manually trigger reply pipeline now |
| `POST` | `/api/test/notification` | Send a test ntfy push |

### Posts (Reply Queue)

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/posts` | Recent posts (default: last 24 h). `?hours=N` |
| `GET` | `/api/posts/:id` | Single post by ID |
| `GET` | `/api/posts/pending` | All PENDING_APPROVAL posts |
| `GET` | `/api/posts/stats` | Dashboard stats (pending, posted, skipped, total 24 h) |
| `GET` | `/api/activity` | Activity log. `?limit=N` (default 100) |
| `GET` | `/api/settings/all` | All settings key-value pairs |
| `PATCH` | `/api/settings/update` | Bulk update settings |
| `PATCH` | `/api/posts/:id/reply` | Edit pending reply text before posting |
| `POST` | `/api/posts/:id/regenerate` | Regenerate reply for a post |

### Actions

| Method | Path | Description |
|---|---|---|
| `POST` or `GET` | `/api/actions/approve/:id` | Approve a pending reply (GET supports signed token query param for ntfy HTTP actions) |
| `POST` or `GET` | `/api/actions/skip/:id` | Skip a pending reply |
| `GET` | `/api/actions/status` | Whether system is currently running |
| `POST` | `/api/actions/toggle` | Pause / resume system |

### Schedule

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/schedule/today` | All of today's scheduled pipeline + original-post times |
| `GET` | `/api/schedule/upcoming` | Next N run times across all job types. `?limit=N` |

### Original Posts

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/original-posts` | Recent original posts with impression data |
| `GET` | `/api/original-posts/topic-performance` | Per-topic engagement stats |
| `GET` | `/api/original-posts/schedule/today` | Today's scheduled original post times |
| `GET` | `/api/original-posts/schedule/upcoming` | Next N upcoming slots. `?limit=N` |
| `POST` | `/api/original-posts/trigger` | Post an original tweet now (bypasses schedule) |
| `POST` | `/api/original-posts/sync-impressions` | Sync engagement for recent originals now |

### Audience

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/audience/heatmap` | 7×24 follower activity matrix |
| `POST` | `/api/audience/refresh` | Scrape and refresh heatmap now |

### Analytics

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/analytics/overview` | Performance summary including `actions_per_1k_impressions` and Tournament vs control. `?days=N` |
| `POST` | `/api/analytics/weekly-digest/send` | Generate and send the weekly ntfy digest now |

### Context / RAG

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/context/health` | RAG health, per-source status, and brain snapshot |
| `GET` | `/api/context/brain` | Source clusters, topic links, corpus neighbors, memory summary |
| `GET` | `/api/context/trends` | Topic velocity map (6 h vs 24 h ratio) |
| `GET` | `/api/context/recent` | Recent ingested context items. `?limit=N` |
| `GET` | `/api/context/preview` | Preview enrichment (topic web always; Voyage when enabled). `?q=TEXT&k=5&tokens=500` |
| `GET` | `/api/context/neural-memory` | Full neural concept graph (nodes + edges) for D3 visualization |
| `POST` | `/api/context/test-reply` | Debug full reply generation with live context. Body: `{text, handle, language}` |

### Agent

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/agent/status` | Agent readiness (Claude CLI present, config) |
| `GET` | `/api/agent/investigations` | Error investigations. `?status=PROPOSED\|DISMISSED\|APPLIED` |
| `GET` | `/api/agent/investigations/:id` | Single investigation + associated agent run |
| `GET` | `/api/agent/features` | Feature task list. `?status=PENDING\|IN_PROGRESS\|COMPLETED` |
| `GET` | `/api/agent/runs` | Agent run history. `?limit=50` |
| `GET` | `/api/agent/runs/:id` | Single agent run detail |
| `GET` | `/api/agent/runs/:id/stream` | SSE stream of live agent run progress |
| `POST` | `/api/agent/watch/tick` | Force watcher poll now |
| `POST` | `/api/agent/investigate` | Spawn investigator for selected activity log entries. Body: `{activityIds: []}` |
| `POST` | `/api/agent/investigations/:id/apply` | Spawn implementer to code the fix and open a PR |
| `POST` | `/api/agent/investigations/:id/dismiss` | Dismiss an investigation |
| `POST` | `/api/agent/features` | Submit a feature request. Body: `{title, description}` |
| `GET` | `/api/agent/features/:id` | Feature task + associated run |

---

## Scheduler Overview

All scheduler jobs are backed by the `scheduled_runs` SQLite table with jittered-grid timestamps generated at boot and midnight each day.

| Job | File | Trigger | What it does |
|---|---|---|---|
| **Reply pipeline** | `scheduler/random_runs.ts` | 5×/day (configurable), random offsets within active window (default 09:00–22:00), 60 s tick | Ingest timeline → filter → score → classify → generate → approval or automatic post |
| **Reply retry queue** | `pipeline/reply_retry.ts` | Each random-run tick | Retry one eligible transient posting failure |
| **Original posts** | `scheduler/original_posts.ts` | 7×/day (4 ORIGINAL + 2 ENGAGEMENT_FARM + 1 QUOTE_TWEET), jittered grid, 60 s tick | Draft and post a single tweet, thread, or quote tweet |
| **Impression sync** | `scheduler/original_posts.ts` | Every 2 h (10 min initial delay), `setTimeout` chain | Playwright scrapes engagement for recent originals |
| **Reply metrics sync** | `scheduler/reply_metrics_sync.ts` | Periodic | Scrape reply engagement and update interaction success scores |
| **Follower sync** | `scheduler/follower_sync.ts` | Periodic (configurable interval) | Detect followers/unfollows and apply the auto-follow policy |
| **Follow-back processor** | `scheduler/follow_back_processor.ts` | Periodic | Execute approved follow-back actions, respect daily cap + blocklist |
| **Audience heatmap sync** | `scheduler/audience_sync.ts` | Periodic (configurable interval) | Playwright scrapes 7×24 follower activity matrix |
| **Session watchdog** | `scheduler/session_health.ts` | Periodic | Detect expired X login, alert, and pause schedulers |
| **Weekly digest** | `scheduler/weekly_digest.ts` | Sunday at configured hour | Send the weekly performance summary via ntfy |
| **Context ingest** | `context/ingest/scheduler.ts` | Per-source intervals (typically 30–120 min) | Fetch default brain sources, SHA-256 + near-dup filter, Voyage embed, store topics |
| **Agent watcher** | `agent/watcher.ts` | Every `AGENT_WATCH_INTERVAL_MS` (5 min default) | Poll activity_log for recurring errors; spawn investigator if threshold hit |
| **Approval expiry sweep** | `scheduler/cron.ts` | Every 5 min | Expire PENDING_APPROVAL posts older than `approval_timeout_min` |

**Jittered grid scheduling:** the active window is divided into N equal slots; each slot gets a random offset to avoid predictable posting patterns. Types are assigned to slots via Fisher-Yates shuffle (original posts). Daily slots are written to `scheduled_runs` at midnight.

---

## Dashboard Overview

A single-page app served from `public/` at `http://localhost:3000`. Accessible on iPhone via LAN or Tailscale.

### Header
- System on/off toggle (pauses/resumes all scheduler jobs)
- **Run Now** button (manual pipeline trigger)
- Refresh button
- Light/dark theme toggle
- Stats bar: Pending · Posted · Skipped · Total (24 h) · New Followers

### Primary Tabs

| Tab | What it shows |
|---|---|
| **Queue** | PENDING_APPROVAL posts. Cards show tweet, author, score, generated reply, Tournament metadata, and `last_error` on ERROR/SKIPPED. Actions: Edit · Approve · Skip · Regenerate |
| **Followers** | Pending follower events with Follow Back / Skip actions; recent follow-back history |
| **Accounts** | All classified accounts with filters by classification type; shows bio, follower count, classification confidence, Marathi creator flag |
| **Originals** | Recent original posts with impression sparklines; per-topic engagement performance |
| **Analytics** | Follower growth, reply success by class/source, topic trends, posting hours, bait tuning, and Tournament quality (actions / 1k impressions) |
| **Activity** | Audience heatmap — 7-day × 24-hour follower activity grid |
| **RAG** | Source health, brain clusters, linked topics, topic velocity, recent ingestion |
| **Agent** | Investigations, feature tasks, agent run history with live SSE |
| **History** | Full activity log (INGESTED → FILTERED → SCORED → PENDING_APPROVAL → POSTED/SKIPPED/EXPIRED/ERROR) |
| **Console** | Real-time log stream |

### Secondary Tabs

| Tab | What it shows |
|---|---|
| **Mind (🧠)** | D3 force-directed graph of neural schema memory; trending topics; context source health |
| **Settings** | Live knobs: wit, keywords, score, windows, follow-back, Conversation Gravity, Reply Tournament rollout, bait %, agent, image posts |

---

## Database Schema

All data lives in `data/xposter.db` (SQLite WAL mode). Override path with `DB_PATH_OVERRIDE`. For a consistent hot backup, run `scripts/xposter_backup_run.sh`.

| Table | Purpose | Key Fields |
|---|---|---|
| `posts` | Every ingested tweet with full lifecycle | tweet_id (UNIQUE), author_handle, text, status, score, generated_reply, final_reply, posting_attempts, retry_after, last_error, tournament_strategy/angle/critic_score/reasons |
| `accounts` | X account metadata + classification cache | handle (PK), display_name, bio, verified, follower_count_seen, is_marathi_creator, classification (9 types), classification_confidence, classified_at |
| `interactions` | Outbound replies with engagement tracking | post_id (FK posts), our_reply_text, our_tweet_url, likes, replies, retweets, author_engaged, success_score |
| `activity_log` | Append-only pipeline event log | post_id, event type, detail, created_at |
| `settings` | Key-value store for live-editable settings | key (PK), value (TEXT) |
| `original_posts` | Posts we authored (not replies) | content, topic, post_type (ORIGINAL/ENGAGEMENT_FARM/QUOTE_TWEET), thread parts/IDs, source tweet metadata, status, tweet URL |
| `post_impressions` | Periodic engagement snapshots | original_post_id (FK), impressions, likes, replies, retweets, checked_at |
| `follower_events` | Follower relationship events | author_handle, event (NEW_FOLLOWER/FOLLOW_BACK_DUE/UNFOLLOWED), status (PENDING/FOLLOWED_BACK/SKIPPED) |
| `scheduled_runs` | Today's jittered run timestamps | date_key, run_at (unix sec), kind (RANDOM_RUN/ORIGINAL_POST), detail (post type), fired |
| `context_items` | RSS/Reddit/weather items | source, source_url, title, body, topics (JSON), published_at, credibility (0–1), body_hash (SHA-256 dedup) |
| `context_source_health` | Per-source polling health | source (PK), last_ok_at, consecutive_failures |
| `vec_context` | sqlite-vec virtual table (ANN) | rowid (FK context_items), embedding (float32 blob, 512 dim default) |
| `audience` | Follower activity heatmap | cells_json (7×24 JSON matrix), fetched_at |

Logs rotate daily in `logs/` via `winston-daily-rotate-file`.

---

## Context / RAG System

Enable Voyage retrieval with `CONTEXT_ENABLED=true` and a `VOYAGE_API_KEY`. Linked-topic `[TOPIC BRAIN]` blocks still inject on replies when Voyage is off.

Default ingest is a **related brain**, not a world-news firehose:

| Cluster | Default sources |
|---|---|
| **Pune civic** | Indian Express / HT / TOI Pune, r/pune, wttr.in Pune weather |
| **India work** | Jobs, workplace, economy, RBI, Inc42, YourStory, ET economy/startups, IE/Hindu/NDTV India, r/startups |
| **AI / tech (jobs lens)** | IE AI/tech, Mint AI/tech, Inc42 AI Shift, ET tech, TechCrunch AI, VentureBeat AI, Google AI, DeepMind, SemiAnalysis, MIT TR, BBC Tech |
| **Opt-in** | World geopolitics, gadgets, EV/space, generic TechCrunch/HN/Verge, ESPN Cricinfo, r/india — set a URL in `.env` to enable |

**Deduplication:** SHA-256 hash of body prevents re-embedding the same article. Cosine distance < 0.06 against recent (48 h) embeddings filters near-duplicates.

**Topic graph:** static neighborhoods (`traffic → metro, roads, civic`; `ai → jobs, startup, tech`) plus co-occurrence edges from recent `context_items`. Retrieval expands the query with those neighbors and prefers items on the web.

**Retrieval:** query + related topics → Voyage embed → sqlite-vec KNN → re-rank by similarity, recency, credibility, and query/linked topic overlap → `[CURRENT CONTEXT]`.

**Monitoring:** `/api/context/health` and `/api/context/brain` (clusters, links, memory). `/api/context/preview?q=TEXT` shows the enrichment block, including linked topics.

---

## Claude Agent (Self-Healing)

An optional autonomous error-investigation and fix system. Requires `claude` CLI and `gh` CLI in PATH.

**How it works:**

1. **Watcher** (`agent/watcher.ts`) polls `activity_log` every 5 min for recurring error events
2. When an error type exceeds `agent_error_threshold` consecutive occurrences, an **investigation** is created in the `investigations` table
3. An **investigator** agent (Claude Code CLI) analyzes the codebase, proposes a root-cause diagnosis and fix — output stored as structured `Investigation` record
4. Investigation appears in the **Agent** tab on the dashboard for your review
5. Clicking **Apply** spawns an **implementer** agent in a fresh git worktree; it codes the fix, runs tests, and opens a PR against `main`
6. You can also submit **feature tasks** from the dashboard; these queue up for the implementer

**Safety guardrails:**
- `AGENT_DISALLOWED_PATHS` — paths the agent cannot read or modify
- `AGENT_MAX_RUNS_PER_DAY` — hard daily cap on invocations
- `AGENT_ALLOW_WEB` (default `false`) — must opt in to external web access
- All implementer work happens in an isolated worktree; nothing merges until you approve the PR on GitHub
- SSE stream (`/api/agent/runs/:id/stream`) lets you watch the agent run token-by-token in the dashboard

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js (ESM), TypeScript 5.7, `tsx` hot reload |
| Browser automation | Playwright 1.49 + playwright-extra + puppeteer-extra-plugin-stealth |
| LLM | Groq SDK → `openai/gpt-oss-120b` (configurable) |
| Embeddings | Voyage AI `voyage-3-lite` via REST API |
| Vector search | `sqlite-vec` (vec0 virtual table, ANN) |
| Database | `better-sqlite3` 9.4, WAL mode, foreign keys |
| Web server | Express 4, CORS, Morgan |
| Notifications | ntfy (ntfy.sh or self-hosted) |
| Language detection | `franc` + custom Marathi marker sets |
| HTTP client | `axios` |
| RSS parsing | `rss-parser` + malformed-XML tolerant fallback |
| Dashboard charts | D3.js v7 (force graph, heatmap) |
| Logging | `winston` + `winston-daily-rotate-file` (`logs/`) |
| Validation | `zod` |
| Agent SDK | `@anthropic-ai/claude-agent-sdk` 0.3 (optional) |
| Testing | Vitest + coverage |
