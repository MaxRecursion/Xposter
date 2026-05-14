# Xposter

A personal X/Twitter automation tool that runs locally on your Mac. It ingests your timeline via Playwright, scores and filters tweets, generates sharp AI replies, posts them automatically, and publishes 7 original posts per day — all while sending real-time push notifications to your iPhone through ntfy.

Built for a Pune-based operator. Knows Pune, Marathi, Hinjewadi, the monsoon, and has opinions about PMC.

---

## Key Features

- **Automated reply pipeline** — timeline ingestion → language detection → scoring → author classification → AI reply generation → Playwright posting → iPhone push notification
- **Original post scheduler** — 7 posts/day (5 research-backed originals + 2 engagement-farm hot takes), randomly distributed across a configurable active window
- **Neural schema memory** — concept graph built from every post and reply ever made; recency × engagement weighted; injected into prompts to avoid repetition and maintain voice consistency
- **Context RAG layer** — Voyage AI embeddings + sqlite-vec ANN search over RSS feeds, Reddit, and live weather; re-ranked by similarity × recency × credibility × topic overlap
- **Trend detection** — 6h vs 24h velocity computed from the context corpus; influences topic selection for originals
- **Dual persona system** — "Pune Punekar" persona for Pune-topic tweets, "sharp observer" for everything else; auto-detected from tweet content
- **Adjustable wit level** — 0–100 slider maps to five tiers (SERIOUS → MEASURED → BALANCED → WITTY → SHARP) with distinct prompt instructions per tier
- **Account classifier** — LLM-based (with heuristic short-circuit) into 9 types; cached with a 7-day TTL; classification shapes the reply tone
- **Language detection** — Devanagari Marathi, Roman-script Marathi (transliterated), Hindi, English; custom marker-based detection with `franc` fallback
- **Impression sync** — every 2 hours, Playwright scrapes engagement metrics for recently posted originals
- **iPhone dashboard** — accessible on LAN or via Tailscale; full-featured SPA with 8 tabs
- **ntfy push notifications** — "Reply Posted" alert with one-tap Delete button; follower alerts with Follow Back / Skip

---

## Architecture

```
┌───────────────────────────────────────────────────────────────┐
│  Mac (runs 24/7)                                              │
│                                                               │
│  ┌─────────────┐    ┌─────────────────────────────────────┐  │
│  │  Express    │    │  Scheduler                          │  │
│  │  Server     │    │  ├─ random_runs.ts  (5x/day reply)  │  │
│  │  :3000      │    │  ├─ original_posts.ts (7x/day OG)   │  │
│  │  ├─ /api/*  │    │  ├─ follower_sync.ts                │  │
│  │  └─ SPA     │    │  └─ context/ingest/scheduler.ts     │  │
│  └──────┬──────┘    └──────────────┬────────────────────--┘  │
│         │                          │                           │
│         │           ┌──────────────▼──────────────────────┐  │
│         │           │  Reply Pipeline (runPipeline)        │  │
│         │           │  1. Playwright → ingest timeline     │  │
│         │           │  2. filter.ts  → language + keyword  │  │
│         │           │  3. scorer.ts  → 0–100 score         │  │
│         │           │  4. classifier.ts → account type     │  │
│         │           │  5. generator.ts → Groq LLM reply    │  │
│         │           │  6. posting.ts → Playwright post     │  │
│         │           │  7. ntfy notification to iPhone       │  │
│         │           └─────────────────────────────────────-┘  │
│         │                                                       │
│         │           ┌─────────────────────────────────────┐   │
│         │           │  Original Post Pipeline              │   │
│         │           │  1. pickTopicAndCategory()           │   │
│         │           │  2. gatherResearchContext()          │   │
│         │           │  3. Groq LLM → draft + quality gate  │   │
│         │           │  4. compose.ts → Playwright post     │   │
│         │           └─────────────────────────────────────-┘   │
│         │                                                       │
│         │    ┌──────────────────────────────────────────────┐  │
│         │    │  Context Layer                                │  │
│         │    │  ├─ neural_memory.ts  (concept graph)        │  │
│         │    │  ├─ store/store.ts    (Voyage + sqlite-vec)  │  │
│         │    │  ├─ retrieve/retriever.ts (re-ranker)        │  │
│         │    │  └─ sources: rss.ts / reddit.ts / weather.ts │  │
│         │    └──────────────────────────────────────────────┘  │
│         │                                                       │
│         │    ┌──────────────────────────────────────────────┐  │
│         │    │  SQLite (WAL)  data/xposter.db               │  │
│         │    │  posts · accounts · interactions · settings  │  │
│         │    │  original_posts · context_items · vec_context│  │
│         │    │  activity_log · follower_events · scheduled_ │  │
│         │    └──────────────────────────────────────────────┘  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
        │                             │
   iPhone (Safari / Tailscale)    ntfy app
   Dashboard tabs                 push alerts + Delete button
```

---

## Core Subsystems

### 1. Reply Pipeline

**Entry point:** `src/scheduler/cron.ts → runPipeline()`

The pipeline is guarded by a mutex (`_running`) so concurrent runs are dropped, not queued.

| Stage | File | What happens |
|---|---|---|
| Ingest | `browser/ingestion.ts` | Playwright scrapes last 60 tweets from your timeline |
| Upsert | `storage/queries.ts` | New tweets are inserted; duplicates by `tweet_id` are silently dropped |
| Filter | `pipeline/filter.ts` | Language detection (Devanagari/Roman Marathi, English pass; Hindi/Unknown fail) + keyword matching. Marathi posts pass unconditionally; English posts require at least one topic keyword match |
| Score | `pipeline/scorer.ts` | 0–100 composite: recency (0–30, 6h decay), topic relevance (0–30, keyword weights), reply opportunity (0–20, question/complaint/help patterns), engagement sweet spot (0–10, avoids zero and viral) |
| Rank | `pipeline/scorer.ts` | Sort descending; take top `max_candidates_per_run` (default 3) above `min_score` threshold (default 40); fallback: take single best if none qualify |
| Classify | `pipeline/classifier.ts` | Heuristic short-circuit (PCF label, bot handle pattern, news keywords, follower counts) → Groq LLM classify → store in `accounts` table with 7-day TTL. Types: SERIOUS, NEWS, PARODY, COMEDY, INFLUENCER, REGULAR, BOT, BRAND_PROMO, UNKNOWN |
| Generate | `pipeline/generator.ts` | Picks `Flavor` (pune vs. general) by regex + topic tags; reads `wit_level` setting → maps to WitTier; assembles system prompt + classification guidance + context block (Voyage retrieval, up to 4 items) + neural memory block (up to 3 past events, 900 chars); calls Groq at temp 0.8–0.95 |
| Post | `browser/posting.ts` | Playwright navigates to tweet URL and submits reply |
| Notify | `notifications/ntfy.ts` | iPhone push with score, classification, tweet/reply text, and a one-tap "Delete Reply" HTTP action |

**Status lifecycle:** `INGESTED → FILTERED → SCORED → GENERATING → POSTING → POSTED` (or `SKIPPED / ERROR / EXPIRED / DELETED`)

### 2. Original Post Pipeline

**Entry points:** `src/scheduler/original_posts.ts`

**Schedule generation** (`generateRandomSlots`):
- At boot and midnight, generates 7 random timestamps for the day
- Active window: `active_window_start_hour` (9) to `active_window_end_hour` (22)
- Window split into N equal slots; one random offset picked per slot (jittered grid — guarantees even distribution, no two runs within ~`window/2N` of each other)
- **Fisher-Yates shuffle** over a `[ENGAGEMENT_FARM, ENGAGEMENT_FARM, ORIGINAL, ORIGINAL, ORIGINAL, ORIGINAL, ORIGINAL]` array assigns types to slots

**Post types:**
- `ORIGINAL` — topic picked from category pools; research context gathered from recent timeline tweets + context store + neural memory; 3–4 sentence take ending with an open question; up to 2 re-attempts on quality failure; compacts to 280 chars if slightly over
- `ENGAGEMENT_FARM` — provocative hot take with an open debate question; 40% chance of strategic Pune-tech-economy slant; temp 0.95

**Topic selection** (`pickTopicAndCategory`):
1. Weighted random category pick (default weights: `pune-tech-economy` 40%, `local-pune` 20%, `tech` 15%, `sports` 8%, `politics` 7%, `culture` 7%, `observation` 3%)
2. Within the category, topic weighted by: past engagement performance × trend velocity (clamped 0.6–2.5) × recency penalty (30% weight for topics used in last 5 posts)

**Impression sync:** every 2 hours, Playwright scrapes likes/replies/retweets/impressions for all recently posted originals; stored in `post_impressions` table.

### 3. Neural Memory Layer

**File:** `src/context/neural_memory.ts`

A lightweight associative memory graph inspired by neural schema theory. Built entirely from SQLite data — no external store — so it accumulates automatically as the account posts.

**Structure:**
- **Nodes** — concepts extracted from all past originals and replies: topic tags (from `detectTopics()`), strategic terms (AI, automation, jobs, pune, hinjewadi, …), bigrams matching strategic patterns
- **Edges** — concept co-occurrence pairs, weighted by the event's score
- **Event weight** = `recencyWeight × engagementWeight`
  - Recency: `0.35 + exp(-ageDays / 45)` — 45-day half-life, floor at 0.35
  - Engagement: `1 + log1p(engagement) / 4`

**Recall** (`recallNeuralMemory`):
1. Load up to 220 events from `original_posts` + `interactions` tables
2. Extract query concepts from the current tweet text
3. Score each past event: `overlap × 2.2 + edgeBoost × 0.18 + nodeBoost × 0.04 + eventScore`
4. Return top 3–4 events as a `[LEARNED MEMORY]` block injected before the tweet in the prompt

The block tells the model to treat past patterns as **preference signal only**, not as facts — avoiding hallucination while preserving voice continuity.

**Dashboard visualization:** the `🧠 Mind` tab renders nodes/edges as a D3 force-directed graph (top 35 nodes, 60 edges), with node size proportional to weight.

### 4. Context RAG Layer

**Files:** `src/context/store/store.ts`, `src/context/retrieve/retriever.ts`, `src/context/enrich.ts`

Enabled by `CONTEXT_ENABLED=true`. Requires `VOYAGE_API_KEY`.

**Embedding:** Voyage AI `voyage-3-lite` at 512 dimensions (configurable). Both `document` and `query` embedding types used to match Voyage's asymmetric retrieval design.

**Ingestion** (`ContextStore.upsertAndEmbed`):
1. SHA-256 hash dedup — exact duplicate bodies are dropped before any embedding is spent
2. Batch embed the remaining items
3. Cosine near-duplicate check against recent (48h) items in `vec_context` — items within distance 0.06 are dropped as near-duplicates
4. Insert into `context_items` + `vec_context` in a single SQLite transaction

**Sources** (all configurable via `.env`):
| Source | Default interval | Credibility | TTL |
|---|---|---|---|
| RSS feeds (IE Pune, HT Pune, Mint AI, Inc42, YourStory, RBI, etc.) | 30 min | 0.7–0.85 | 7 days |
| Reddit r/pune, r/india | 60 min | 0.55–0.60 | 3 days |
| wttr.in weather (Pune) | 60 min | 0.80 | 6 hours |

RSS parsing includes a tolerant fallback for malformed XML (bare ampersands, unescaped entities) common in Indian news feeds.

**Retrieval** (`Retriever.retrieve`):
1. Embed query via Voyage
2. ANN search (`vec0 KNN`) over `vec_context`, fetching `k×3` candidates
3. Filter: drop items with cosine distance > 0.95; fall back to top 3 if all filtered
4. Re-rank by composite score: `0.55×similarity + 0.25×recency + 0.10×credibility + 0.10×topicOverlap`
5. Recency uses a 12-hour half-life exponential decay

The resulting items are rendered as a `[CURRENT CONTEXT]` block with source label, age, and truncated body — injected into both reply and original post prompts.

### 5. Trend Detection

**File:** `src/context/trends.ts`

Reads topic JSON arrays from all `context_items` published in the last 24 hours. Computes per-topic **velocity** = `(last6h_count + 1) / (last24h_count / 4 + 1)`. A velocity > 1 means the topic is over-represented in the last 6 hours relative to its 24-hour average — i.e., it's trending.

The velocity map feeds into `pickTopicAndCategory()` to boost trending topics for original posts, and is exposed on the dashboard's `🧠 Mind` tab and the `/api/context/trends` endpoint.

### 6. Dashboard

A single-page application served from `public/index.html`. Accessible at `http://localhost:3000` or on your iPhone via LAN or Tailscale.

| Tab | What it shows |
|---|---|
| **Queue** | Tweets currently scored/generating/pending; shows score breakdown |
| **Followers** | Pending follower events (NEW_FOLLOWER, FOLLOW_BACK_DUE) with approve/skip |
| **Accounts** | All seen accounts with classification, follower counts, Marathi flag |
| **Originals** | Posted original tweets with live impression counts (likes/replies/retweets/impressions) |
| **History** | Full activity log (`activity_log` table); every pipeline event visible |
| **Console** | Hacker-style event feed; latest system events |
| **🧠 Mind** | D3 force-directed neural memory graph + trending topics + context source health |
| **Settings** | Live-edit all key settings (wit_level, min_score, topic_keywords, category weights, etc.) without restart |

### 7. Scheduler

Three parallel scheduling loops, all backed by the `scheduled_runs` SQLite table:

**Reply pipeline** (`scheduler/random_runs.ts`):
- At boot, generates N random timestamps (default 5) for today within the active window
- Uses a jittered grid: window split into N equal slots, one random offset per slot
- 60-second `setInterval` tick polls for due rows; fires one at a time

**Original post scheduler** (`scheduler/original_posts.ts`):
- Same jittered-grid approach; 7 slots/day with Fisher-Yates shuffled types
- Separate tick (60s); impression sync runs every 2 hours via `setTimeout` chain

**Follower sync** (`scheduler/follower_sync.ts`):
- Periodically scrapes follower list via Playwright; detects new followers; sends ntfy notification with Follow Back / Skip action buttons

**Stale post expiry:** a 5-minute `setInterval` sweeps `PENDING_APPROVAL` posts older than `approval_timeout_min` (default 30) and marks them `EXPIRED`.

### 8. Browser Automation

**File:** `src/browser/session.ts`

Playwright with `playwright-extra` and the `puppeteer-extra-plugin-stealth` plugin. Uses a **persistent browser context** (stored in `./browser-profile`) so session cookies survive restarts.

**Login strategy:** X silently blocks Playwright-driven login flows. Instead, the user logs in to x.com in their regular Chrome, copies the `auth_token` and `ct0` cookies from DevTools, and sets them in `.env` as `X_AUTH_TOKEN` / `X_CT0`. These are injected into the persistent context at boot. Cookies typically last ~1 year.

Uses the system's installed Google Chrome (`channel: 'chrome'`) rather than Playwright's bundled Chromium, which is more aggressively flagged as automation.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js (ESM), TypeScript 5.7, `tsx` for hot-reload dev |
| Browser automation | Playwright 1.49 + playwright-extra + puppeteer-extra-plugin-stealth |
| LLM | Groq SDK → `llama-3.3-70b-versatile` (configurable) |
| Embeddings | Voyage AI `voyage-3-lite` via REST API |
| Vector search | `sqlite-vec` (vec0 virtual table) |
| Database | `better-sqlite3` 9.4 with WAL mode + foreign keys |
| Web server | Express 4, CORS, Morgan |
| Notifications | ntfy (self-hosted or ntfy.sh) |
| Language detection | `franc` + custom marker sets |
| HTTP client | `axios` |
| RSS parsing | `rss-parser` with malformed-XML tolerant fallback |
| Dashboard charts | D3.js v7 (loaded from jsDelivr CDN) |
| Logging | `winston` + `winston-daily-rotate-file` |
| Validation | `zod` |
| Testing | Vitest |

---

## Setup & Configuration

### Prerequisites

- Node.js 22+
- Google Chrome installed (the bot uses your system Chrome, not Playwright's bundled one)
- A Groq API key (free tier is sufficient)
- X account with `auth_token` + `ct0` cookies (see below)
- ntfy app on iPhone (optional but strongly recommended)

### Installation

```bash
git clone <repo>
cd Xposter
npm run setup        # npm install + playwright install chromium + copy .env.example
cp .env.example .env # already done by setup
```

Edit `.env` — minimum required fields:

```bash
GROQ_API_KEY=...         # from console.groq.com
X_AUTH_TOKEN=...         # from x.com DevTools → Application → Cookies
X_CT0=...                # same location as auth_token
API_KEY=...              # openssl rand -hex 32
NTFY_TOPIC=...           # hard-to-guess string, subscribe in ntfy iOS app
```

### Environment Variables

#### Server
| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Dashboard/API port |
| `HOST` | `0.0.0.0` | Bind address (0.0.0.0 for LAN access) |
| `API_KEY` | — | Secret for mutation endpoints; generate with `openssl rand -hex 32` |
| `TRUST_DASHBOARD_ORIGIN` | `true` | Trust same-LAN origins without API key |

#### Browser / X Auth
| Variable | Default | Description |
|---|---|---|
| `BROWSER_HEADLESS` | `true` | Set `false` to see the browser window |
| `BROWSER_USER_DATA_DIR` | `./browser-profile` | Playwright persistent context directory |
| `X_AUTH_TOKEN` | — | X session cookie; copy from DevTools |
| `X_CT0` | — | X CSRF cookie; copy from DevTools |

#### LLM
| Variable | Default | Description |
|---|---|---|
| `GROQ_API_KEY` | — | Required |
| `GROQ_MODEL` | `llama-3.3-70b-versatile` | Model for reply and original post generation |
| `GROQ_CLASSIFIER_MODEL` | (GROQ_MODEL) | Separate model override for account classification |
| `LOG_PROMPTS` | `true` | Print full system+user prompts to stdout |

#### Notifications
| Variable | Default | Description |
|---|---|---|
| `NTFY_TOPIC` | — | Subscribe to this in the ntfy iOS app |
| `NTFY_SERVER` | `https://ntfy.sh` | Use a self-hosted server if preferred |
| `NTFY_ACTION_MODE` | `view` | `view` opens signed URL in browser; `http` does silent background POST |
| `CALLBACK_NETWORK` | `lan` | `lan` or `tailscale` — how ntfy action buttons reach back to your Mac |
| `CALLBACK_BASE_URL` | (auto-detected) | Override the callback base URL explicitly |
| `TAILSCALE_IP` | (auto-detected) | Override Tailscale IP if auto-detection fails |

#### Scheduler
| Variable | Default | Description |
|---|---|---|
| `INGEST_CRON` | `*/15 * * * *` | Legacy cron expression (informational; actual scheduling is via random_runs) |
| `MAX_CANDIDATES_PER_RUN` | `3` | Max replies to generate per pipeline run |
| `APPROVAL_TIMEOUT_MINUTES` | `30` | Minutes before a pending reply auto-expires |
| `MIN_REPLY_INTERVAL_SECONDS` | `300` | Safety floor between posted replies |
| `ACTION_TOKEN_TTL_SECONDS` | `86400` | Signed ntfy action URL expiry |

#### Context / RAG (optional)
| Variable | Default | Description |
|---|---|---|
| `CONTEXT_ENABLED` | `false` | Master switch; set `true` to enable RAG |
| `VOYAGE_API_KEY` | — | Required when context is enabled |
| `VOYAGE_DIM` | `512` | Embedding dimension (256/512/1024); changing requires a fresh vec_context table |
| `VOYAGE_RPM` | `2.7` | Rate limit cap (free tier = 3 RPM) |
| `CONTEXT_INGEST_INTERVAL_MIN` | (per-source defaults) | Override poll interval for all sources |
| `CONTEXT_RSS_IE_PUNE` | `(IE Pune feed)` | RSS feed URLs — set to `""` to disable any source |
| `CONTEXT_REDDIT_PUNE` | `pune` | Reddit subreddit name |
| `CONTEXT_WEATHER_PUNE` | `Pune` | wttr.in location string |

---

## Running

```bash
# Development (hot-reload)
npm run dev

# Production (build first)
npm run build
npm start
```

**On first boot**, if `X_AUTH_TOKEN` is not set or is expired:
1. Set `BROWSER_HEADLESS=false` in `.env`
2. Run `npm run dev` — a Chrome window opens
3. Log in to x.com manually
4. Open DevTools → Application → Cookies → `https://x.com`
5. Copy `auth_token` → `X_AUTH_TOKEN`, copy `ct0` → `X_CT0` in `.env`
6. Set `BROWSER_HEADLESS=true`, restart

**Dashboard:** `http://localhost:3000`
**iPhone (same WiFi):** the LAN URL is logged on startup, e.g. `http://192.168.1.42:3000`
**iPhone (Tailscale):** install Tailscale on Mac + iPhone, set `CALLBACK_NETWORK=tailscale`

---

## Data Persistence

All data lives in `data/xposter.db` (SQLite, WAL mode). Override with `DB_PATH_OVERRIDE`.

### Tables

| Table | Purpose |
|---|---|
| `posts` | Every ingested tweet + full lifecycle status, score, generated reply |
| `accounts` | Every X account encountered + LLM classification, bio, follower counts |
| `interactions` | Every reply we posted, with engagement tracking (likes/replies/retweets received) |
| `activity_log` | Append-only event log; powers the Console and History tabs |
| `settings` | Key-value store; live-editable from the dashboard Settings tab |
| `original_posts` | Every original tweet we authored (not a reply), with topic and research context |
| `post_impressions` | Periodic engagement snapshots for original posts (scraped every 2h) |
| `follower_events` | Detected follower changes pending user action |
| `scheduled_runs` | Today's randomly-picked pipeline and original-post run timestamps |
| `context_items` | RSS/Reddit/weather items with metadata, deduped by SHA-256 body hash |
| `context_source_health` | Per-source polling health (last ok, consecutive failures) |
| `vec_context` | sqlite-vec virtual table; stores Voyage embeddings for ANN retrieval |

### Backup

The database file can be copied at any time while the app is running — WAL mode makes hot backups safe. For iCloud: `cp data/xposter.db ~/Library/Mobile\ Documents/com~apple~CloudDocs/Xposter/` or set up a cron.

Logs rotate daily in `logs/` via `winston-daily-rotate-file`.
