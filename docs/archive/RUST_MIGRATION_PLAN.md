# Rust Migration Plan — Xposter

> **Archived 2026-06-10**: This document predates the current architecture and is retained for historical reference only.
>
> **Status**: Research / planning only. No code has been changed.
> **Scope**: Full codebase audit — 7,888 lines of TypeScript across 35+ files.
> **Author**: Claude Sonnet 4.6 — based on complete read of every source file.

---

## 1. Executive Summary

Xposter is a ~8,000-line Node.js/TypeScript application that automates X (Twitter) interactions with a
human-in-the-loop approval flow. It runs as a persistent process on a personal Mac, drives a real
Chrome browser via Playwright with anti-detection stealth patches, speaks to Groq and Voyage AI APIs,
stores state in SQLite with a vector extension (`sqlite-vec`), and serves a local dashboard.

### Why Migrate to Rust?

| Benefit | Honest Assessment |
|---|---|
| **Memory** | Node.js + Playwright idle ≈ 250–450 MB. Rust core ≈ 15–40 MB. Real win, but the Chromium browser process (500+ MB) dominates regardless. |
| **Binary deployment** | Single static binary, no Node.js runtime, no `npm install`. Meaningful for a tool you want to run reliably long-term. |
| **Startup time** | Node.js cold start ≈ 500 ms–1 s. Rust ≈ 30–100 ms. Marginal — this process runs 24/7 and restarts rarely. |
| **Performance** | The app is almost entirely I/O-bound (browser rendering, Groq API, Voyage API, SQLite). CPU-bound work (scoring, language detection, topic matching) finishes in microseconds even in TS. Rust won't move the needle on real throughput. |
| **Type safety** | TypeScript already catches the important bugs at compile time. The dangerous code is in the browser automation layer — Rust's type system can't make scraping X safer. |

### Risks

| Risk | Severity |
|---|---|
| **No mature Playwright equivalent in Rust** | **Critical** — see § 4 |
| `sqlite-vec` needs unsafe C FFI loading | Medium — manageable but fiddly |
| Marathi language detection gaps in Rust crates | Low — existing logic is rule-based and ports cleanly |
| Groq SDK → raw HTTP calls (no official Rust SDK) | Low — the SDK is just a thin wrapper |
| 12–22 person-week investment for a personal tool | High — opportunity cost is enormous |

**Bottom line**: A full Rust migration is technically feasible but economically irrational for a
solo-operated personal tool where the most complex and fragile piece — browser automation with
anti-detection — has no production-ready Rust equivalent. The recommendation is in § 10.

---

## 2. Current Stack Inventory

### Runtime & Tooling

| Package | Version | Role | Rust Equivalent |
|---|---|---|---|
| `typescript` | 5.7 | Language | — (Rust is statically typed) |
| `tsx` | 4.19 | Dev runner | `cargo watch` |
| `vitest` | 4.1 | Test runner | `cargo test` |
| Node.js | 22+ | Runtime | Rust binary |
| ESM modules | native | Module system | Rust crate system |

### HTTP & Server

| Package | Version | Role | Rust Equivalent |
|---|---|---|---|
| `express` | 4.21 | HTTP framework | `axum` 0.7 |
| `cors` | 2.8 | CORS middleware | `tower-http` cors layer |
| `morgan` | 1.10 | HTTP access logging | `tower-http` trace layer |

### Storage

| Package | Version | Role | Rust Equivalent |
|---|---|---|---|
| `better-sqlite3` | 9.4 | SQLite (synchronous) | `rusqlite` 0.32 |
| `sqlite-vec` | 0.1.9 | Vector extension | Same `.dylib` loaded via `rusqlite` + `unsafe` |

### Browser Automation (the hard part)

| Package | Version | Role | Rust Equivalent |
|---|---|---|---|
| `playwright` | 1.49 | Chromium CDP control | `chromiumoxide` 0.7 (partial) |
| `playwright-extra` | 4.3 | Plugin architecture | None |
| `puppeteer-extra-plugin-stealth` | 2.11 | Anti-detection patches | **None — see § 4** |

### LLM & AI

| Package | Version | Role | Rust Equivalent |
|---|---|---|---|
| `groq-sdk` | 0.9 | Groq API client (OpenAI-compat.) | `async-openai` 0.25 or raw `reqwest` |

### HTTP Client

| Package | Version | Role | Rust Equivalent |
|---|---|---|---|
| `axios` | 1.7 | HTTP client (RSS, Reddit, Voyage, wttr.in) | `reqwest` 0.12 |

### Scheduling

| Package | Version | Role | Rust Equivalent |
|---|---|---|---|
| `node-cron` | 4.2 | Cron expressions | `tokio-cron-scheduler` 0.11 |

### Configuration

| Package | Version | Role | Rust Equivalent |
|---|---|---|---|
| `dotenv` | 16.4 | `.env` loading | `dotenvy` 0.15 |

### Logging

| Package | Version | Role | Rust Equivalent |
|---|---|---|---|
| `winston` | 3.17 | Structured logger | `tracing` 0.1 + `tracing-subscriber` |
| `winston-daily-rotate-file` | 5.0 | Log rotation | `tracing-appender` (rolling file) |

### Parsing & Validation

| Package | Version | Role | Rust Equivalent |
|---|---|---|---|
| `rss-parser` | 3.13 | RSS/Atom feed parsing | `feed-rs` 2.0 |
| `franc` | 6.2 | Language detection (n-gram) | `whatlang` 0.16 |
| `zod` | 3.24 | Runtime validation/schemas | `serde` + `validator` |

---

## 3. Architecture Mapping

```
TypeScript Module                  Rust Module
─────────────────────────────────  ─────────────────────────────────────────
src/index.ts                  →    main.rs (startup orchestration)
src/api/server.ts             →    api/mod.rs  (axum Router builder)
src/api/routes/posts.ts       →    api/routes/posts.rs
src/api/routes/actions.ts     →    api/routes/actions.rs
src/api/routes/original_posts →    api/routes/original_posts.rs
src/api/routes/context.ts     →    api/routes/context.rs
src/api/auth.ts               →    api/auth.rs  (middleware layer)

src/pipeline/filter.ts        →    pipeline/filter.rs
src/pipeline/scorer.ts        →    pipeline/scorer.rs
src/pipeline/generator.ts     →    pipeline/generator.rs
src/pipeline/original_post_generator.ts → pipeline/original_post_generator.rs
src/pipeline/classifier.ts    →    pipeline/classifier.rs
src/pipeline/errors.ts        →    pipeline/errors.rs  (thiserror enum)
src/pipeline/topic_categories →    pipeline/topic_categories.rs

src/context/neural_memory.ts  →    context/neural_memory.rs
src/context/enrich.ts         →    context/enrich.rs
src/context/topics.ts         →    context/topics.rs  (compiled regex via once_cell)
src/context/trends.ts         →    context/trends.rs
src/context/retrieve/retriever→    context/retriever.rs
src/context/store/store.ts    →    context/store.rs
src/context/sources/rss.ts    →    context/sources/rss.rs
src/context/sources/reddit.ts →    context/sources/reddit.rs
src/context/sources/weather.ts→    context/sources/weather.rs
src/context/ingest/scheduler  →    context/ingest.rs
src/context/ingest/health.ts  →    context/health.rs
src/context/embeddings/voyage →    embeddings/voyage.rs

src/scheduler/cron.ts         →    scheduler/pipeline.rs
src/scheduler/original_posts.ts→   scheduler/original_posts.rs
src/scheduler/random_runs.ts  →    scheduler/random_runs.rs
src/scheduler/follower_sync.ts→    scheduler/follower_sync.rs

src/storage/db.ts             →    storage/db.rs  (rusqlite + migrations)
src/storage/queries.ts        →    storage/posts.rs
src/storage/original_posts.ts →    storage/original_posts.rs
src/storage/accounts.ts       →    storage/accounts.rs

src/browser/session.ts        →    browser/session.rs  OR  keep as Node.js sidecar
src/browser/ingestion.ts      →    browser/ingestion.rs  (or sidecar)
src/browser/posting.ts        →    browser/posting.rs   (or sidecar)
src/browser/compose.ts        →    browser/compose.rs   (or sidecar)
src/browser/profile.ts        →    browser/profile.rs   (or sidecar)
src/browser/followers.ts      →    browser/followers.rs (or sidecar)
src/browser/impressions.ts    →    browser/impressions.rs (or sidecar)

src/utils/logger.ts           →    utils/logger.rs  (tracing setup)
src/utils/network.ts          →    utils/network.rs
src/notifications/ntfy.ts     →    notifications/ntfy.rs

public/ (D3 dashboard)        →    public/ (unchanged — stays JavaScript)
```

---

## 4. The Hard Problems

This section is the reason the executive summary recommends caution.

### 4.1 Playwright Browser Automation — the critical blocker

The browser layer (`src/browser/`, 1,087 lines) drives a real Chrome window to:
- Scroll and parse the X home timeline (`ingestion.ts`)
- Click through to individual profiles and read bio/follower counts (`profile.ts`)
- Submit reply forms (`posting.ts`) and new tweet forms (`compose.ts`)
- Scrape engagement metrics from posted tweets (`impressions.ts`)
- Follow/unfollow accounts (`followers.ts`)

All of this works because `puppeteer-extra-plugin-stealth` patches ~20 JavaScript fingerprinting
vectors that X uses to detect automation:
- `navigator.webdriver` → `undefined`
- Chrome runtime API shapes → normal user values
- Permission API behavior, plugin enumeration, canvas fingerprinting, font list, WebGL vendor strings
- The session uses your real Chrome installation (`channel: 'chrome'`) — not Playwright's test binary —
  specifically because X flags the standard test binary.

**Rust options assessed:**

| Option | Status | Verdict |
|---|---|---|
| `playwright-rust` (octaltree/playwright-rust) | Abandoned 2022, no stealth support | Unusable |
| `chromiumoxide` 0.7 | Active, pure CDP, no stealth | Functional for basic automation, will likely be detected by X within hours to days |
| `fantoccini` (WebDriver/geckodriver) | Active, no stealth, Firefox only | Same detection problem |
| `thirtyfour` (WebDriver, Chrome) | Active, no stealth | Detected immediately by X (webdriver flag) |
| Manual stealth injection via CDP `Runtime.evaluate` | Theoretically possible | You would be reimplementing the entire stealth plugin in Rust/JS strings. Months of work, never-ending maintenance as X updates detection. |
| **Keep Node.js browser layer as a subprocess** | Clean boundary, no detection risk | **Best option** |

**Conclusion**: There is no production-ready Rust solution for stealthy Chromium automation that
matches puppeteer-extra-plugin-stealth. The only safe migration path keeps the browser layer in Node.js.

### 4.2 `sqlite-vec` via C FFI

`sqlite-vec` is a C extension compiled to a `.so`/`.dylib`. In TypeScript, `better-sqlite3` loads it
via its `loadExtension()` method. In Rust, `rusqlite` can do the same:

```rust
// In Rust:
use rusqlite::Connection;
conn.load_extension(Path::new("sqlite-vec"), None)?;
// Then use the vec0 virtual table as normal SQL.
```

The `rusqlite` crate requires enabling the `loadable_extension` feature and compiling with
`-DSQLITE_ENABLE_LOAD_EXTENSION`. This is entirely standard — many production apps do it. The `.dylib`
file ships alongside the binary. **This is solvable, not a blocker.**

The alternative is `sqlite-vec-rusqlite`, a crate that statically links the vec0 module — no
`.dylib` file needed at runtime. At writing, `sqlite-vec` 0.1.x has a Rust bundled crate. Worth
checking the current version's binding status.

### 4.3 Async Runtime

Node.js uses a single-threaded event loop with libuv. Rust/Tokio uses an M:N thread pool with async
tasks. The translation is mechanically straightforward — `async fn` in TypeScript maps to `async fn`
in Rust, `Promise.all()` maps to `tokio::join!()` or `futures::future::join_all()`.

One important difference: `better-sqlite3` is synchronous and blocks the Node.js event loop
intentionally (all operations complete in microseconds). In Rust with `sqlx` (async), queries return
futures. With `rusqlite` (synchronous), you'd use `tokio::task::spawn_blocking` to avoid blocking
the Tokio reactor. Either works; the `rusqlite` + `spawn_blocking` pattern is clean and familiar.

The VoyageEmbeddings rate-limiter (`src/context/embeddings/voyage.ts`) uses a promise-chain
(`this.chain = next.catch(...)`) to serialize batches while staying async. In Rust this would be an
`Arc<Mutex<tokio::time::Instant>>` for the next-slot tracking, with `tokio::time::sleep_until` for
waiting. More verbose but equivalent.

### 4.4 The D3.js Dashboard Frontend

`public/` contains a single-page application using D3.js v7 for charts (timeline ingestion, neural
memory mind map, etc.). This stays JavaScript regardless of what happens to the backend. The API
contract (JSON shapes, routes, status codes) must be preserved identically. The backend migration is
transparent to the frontend.

### 4.5 Dynamic Typing Patterns

Several patterns in the TypeScript code require special handling in Rust:

**`as any` casts**: Primarily in `storage/accounts.ts` and queries that return rows with mixed
types. In Rust these become `serde_json::Value` or typed structs via `serde`. Typed structs are
strongly preferred.

**JSON-in-SQL columns**: `score_breakdown` (TEXT column storing `{"recency":12.5,...}`),
`topics` (TEXT storing `["monsoon","traffic"]`). In Rust, deserialize on read with `serde_json::from_str`,
serialize on write with `serde_json::to_string`. Define typed structs for these.

**`getSetting()` returning `string` for everything**: The settings table stores all values as
strings. In TypeScript these are parsed inline (`parseInt(getSetting(...), 10)`). In Rust, define a
typed `Settings` struct and parse all values on read from the DB.

**Union types for status enums**: `PostStatus`, `OriginalPostStatus`, `Classification` etc. Map
directly to Rust `enum`s with `serde` string serialization.

**`process.env` reads scattered across modules**: These are called at runtime per-request in many
places. In Rust, parse all env vars into a `Config` struct at startup and pass it via `Arc<Config>`
or `axum::Extension`. Don't use `std::env::var()` at call time.

### 4.6 Language Detection with Devanagari

`franc` is an n-gram based language detector. The Rust crate `whatlang` does similar detection.
However, the language detection in `src/pipeline/filter.ts` is almost entirely rule-based —
hand-crafted marker lists for Marathi vs Hindi Devanagari, and regex lists for Roman-Marathi markers.
`franc` is only a fallback for ambiguous cases.

This code ports almost verbatim to Rust using the `regex` crate (with `lazy_static` or `once_cell`
for compiled regexes). The Unicode ranges work identically. `whatlang` can replace the `franc` fallback.
**This is not a hard problem.**

---

## 5. Rust Crate Recommendations

### Core Infrastructure

| Crate | Version | Reason |
|---|---|---|
| `tokio` | 1.x (full features) | Async runtime. The obvious choice; no reason to consider alternatives. |
| `axum` | 0.7 | Ergonomic, tower-compatible, excellent middleware ecosystem. Prefer over actix-web for new projects. |
| `tower-http` | 0.5 | CORS, tracing/logging middleware, static file serving — replaces cors, morgan, express.static. |
| `tracing` | 0.1 | Structured logging. Standard in the tokio ecosystem. |
| `tracing-subscriber` | 0.3 | Subscriber implementations (stdout JSON, file). |
| `tracing-appender` | 0.2 | Rolling file appender — replaces winston-daily-rotate-file. |

### Storage

| Crate | Version | Reason |
|---|---|---|
| `rusqlite` | 0.32 | Synchronous SQLite, best FFI bindings, supports extension loading. Use with `spawn_blocking`. |
| `rusqlite` features: `bundled` | — | Bundles SQLite statically — no system lib required. |

For `sqlite-vec`: try the `sqlite-vec-rusqlite` bundled crate first. If unavailable for your
`sqlite-vec` version, load the `.dylib` via `conn.load_extension()`.

### HTTP Client

| Crate | Version | Reason |
|---|---|---|
| `reqwest` | 0.12 | Async HTTP, rustls TLS, JSON via serde, timeout support. Replaces axios entirely. |

### AI / External APIs

| Crate | Version | Reason |
|---|---|---|
| `async-openai` | 0.25 | OpenAI-compatible client — Groq's API is OpenAI-compatible. Use `with_api_base()` to point at `https://api.groq.com/openai/v1`. |

### Parsing

| Crate | Version | Reason |
|---|---|---|
| `feed-rs` | 2.0 | RSS and Atom parsing. Pure Rust, handles malformed feeds. Replaces rss-parser. |
| `quick-xml` | 0.36 | If feed-rs doesn't handle a specific malformed feed, quick-xml gives you low-level repair capability. |

### Serialization & Validation

| Crate | Version | Reason |
|---|---|---|
| `serde` | 1.x | Serialization/deserialization. Non-negotiable in Rust. |
| `serde_json` | 1.x | JSON. Required everywhere. |
| `validator` | 0.18 | Struct-level validation via derive macros — replaces Zod for request body validation. |

### Language Detection

| Crate | Version | Reason |
|---|---|---|
| `whatlang` | 0.16 | Language detection from text. Replaces the `franc` fallback path. |
| `regex` | 1.x | Used for Marathi/Hindi marker matching — the core detection logic. |
| `once_cell` | 1.x | Lazy static regex compilation — critical for the 100+ patterns in filter.ts and topics.ts. |

### Scheduling

| Crate | Version | Reason |
|---|---|---|
| `tokio-cron-scheduler` | 0.11 | Cron expressions on the Tokio runtime. Replaces node-cron. |

For the randomized scheduling in `scheduler/random_runs.ts` and `scheduler/original_posts.ts`
(not cron, just random times within a window), use `tokio::time::sleep_until` with computed `Instant` values.

### Configuration & Utilities

| Crate | Version | Reason |
|---|---|---|
| `dotenvy` | 0.15 | `.env` file loading. Direct dotenv replacement. |
| `uuid` | 1.x | UUID generation (replaces `crypto.randomUUID()`). Enable `v4` and `fast-rng` features. |
| `sha2` | 0.10 | SHA-256 for body_hash in context_items (replaces `crypto.createHash('sha256')`). |
| `hex` | 0.4 | Hex encoding of SHA-256 digests. |
| `thiserror` | 1.x | Error enum derivation — replaces the custom error classes. |
| `anyhow` | 1.x | `Box<dyn Error>`-style error propagation for non-library code. |
| `chrono` | 0.4 | Date/time operations (day key generation, slot scheduling). |

### Browser Sidecar IPC (if keeping Node.js browser layer)

| Crate | Version | Reason |
|---|---|---|
| `tokio::process` | built-in | Spawn and communicate with the Node.js browser subprocess. |

Or expose the browser layer as an HTTP service on localhost and call it with `reqwest`. This is
cleaner and easier to test.

---

## 6. Proposed Module Structure

```
xposter-rust/
├── Cargo.toml                     # workspace root
├── Cargo.lock
├── .env.example
├── public/                        # unchanged D3 dashboard (static files)
├── data/                          # SQLite db
├── logs/                          # log rotation output
│
└── crates/
    ├── xposter-core/              # main binary crate
    │   ├── Cargo.toml
    │   └── src/
    │       ├── main.rs            # startup, signal handling
    │       ├── config.rs          # parse all env vars into Config struct
    │       │
    │       ├── api/
    │       │   ├── mod.rs         # axum Router assembly
    │       │   ├── auth.rs        # API key middleware (axum::extract::State)
    │       │   └── routes/
    │       │       ├── posts.rs
    │       │       ├── actions.rs
    │       │       ├── original_posts.rs
    │       │       ├── context.rs
    │       │       ├── accounts.rs
    │       │       ├── follow.rs
    │       │       └── replies.rs
    │       │
    │       ├── pipeline/
    │       │   ├── mod.rs
    │       │   ├── filter.rs      # detectLanguage, filterPost, isDuplicate
    │       │   ├── scorer.rs      # scorePost, rankCandidates
    │       │   ├── generator.rs   # generateReply → async-openai → Groq
    │       │   ├── original_post_generator.rs
    │       │   ├── classifier.rs  # classifyAccount (LLM + heuristics)
    │       │   ├── topic_categories.rs
    │       │   └── errors.rs      # thiserror enum
    │       │
    │       ├── context/
    │       │   ├── mod.rs
    │       │   ├── enrich.rs
    │       │   ├── neural_memory.rs
    │       │   ├── topics.rs      # compiled regex rules, once_cell
    │       │   ├── trends.rs
    │       │   ├── retriever.rs
    │       │   ├── store.rs       # ContextStore, upsertAndEmbed, semanticSearch
    │       │   ├── ingest.rs      # startContextIngest, runOnce
    │       │   ├── health.rs
    │       │   └── sources/
    │       │       ├── rss.rs
    │       │       ├── reddit.rs
    │       │       └── weather.rs
    │       │
    │       ├── embeddings/
    │       │   └── voyage.rs      # VoyageEmbeddings, rate limiter via Mutex<Instant>
    │       │
    │       ├── scheduler/
    │       │   ├── pipeline.rs    # runPipeline, startScheduler
    │       │   ├── original_posts.rs
    │       │   ├── random_runs.rs
    │       │   └── follower_sync.rs
    │       │
    │       ├── storage/
    │       │   ├── db.rs          # getDb (OnceLock), migrations, sqlite-vec load
    │       │   ├── posts.rs       # upsertPost, getPost, updatePostStatus, ...
    │       │   ├── original_posts.rs
    │       │   └── accounts.rs
    │       │
    │       ├── browser/
    │       │   └── client.rs      # HTTP client to Node.js browser sidecar
    │       │                      #   OR chromiumoxide CDP client (if accepting detection risk)
    │       │
    │       ├── notifications/
    │       │   └── ntfy.rs
    │       │
    │       └── utils/
    │           ├── logger.rs      # tracing setup
    │           └── network.rs     # getLocalIP, getTailscaleIP, etc.
    │
    └── xposter-browser-sidecar/   # OPTIONAL: kept as Node.js
        ├── package.json
        └── src/
            ├── server.ts          # HTTP server on localhost:3001
            ├── browser/           # existing browser/ modules unchanged
            └── index.ts
```

---

## 7. Migration Strategy — Phased Plan

### Phase 1: Storage Layer (2 weeks)

**Goal**: Replace `better-sqlite3` + `sqlite-vec` with `rusqlite` + sqlite-vec extension loading.
Replicate all migrations exactly. Validate every query.

**Files**:
- `src/storage/db.ts` → `storage/db.rs` + `storage/migrations.rs`
- `src/storage/queries.ts` → `storage/posts.rs`
- `src/storage/original_posts.ts` → `storage/original_posts.rs`
- `src/storage/accounts.ts` → `storage/accounts.rs`

**Key challenges**:
- The DB uses `sqlite-vec` virtual tables (`vec_context`). Load the extension via
  `conn.load_extension()` before running migrations. The vec0 virtual table query syntax
  (`WHERE embedding MATCH ? AND k = ?`) is identical in SQL.
- The `addColumnIfMissing` migration helper needs to be reproduced. Use `PRAGMA table_info`.
- `score_breakdown` and `topics` are JSON strings in TEXT columns. Define typed Rust structs and
  serialize/deserialize on the boundary.
- The `mutual_follow` GENERATED ALWAYS AS VIRTUAL column — rusqlite reads it fine, no special handling.
- `pragma ignore_check_constraints` in `markReplyDeleted` — rusqlite supports `conn.execute_batch("PRAGMA ignore_check_constraints=ON")`.

**Validation**: Run all existing TS queries against the same `.db` file using both bindings. Output should
be byte-for-byte identical JSON.

---

### Phase 2: HTTP API (1.5 weeks)

**Goal**: Implement all API routes in `axum`. Serve the existing `public/` static files unchanged.
Make the dashboard fully functional against the Rust backend.

**Files**: All `src/api/` modules.

**Key challenges**:
- The CORS logic (`src/api/server.ts:31-50`) has a dynamic origin check (LAN IP, Tailscale IP, localhost).
  In axum, use `tower_http::cors::CorsLayer` with a custom `AllowOrigin::predicate()`.
- `wantsHtml()` in `actions.ts` — returns HTML for ntfy view actions (GET), JSON for dashboard POSTs.
  This is stateless logic based on method + Accept header; ports cleanly.
- The HTML response in `sendActionResponse` — use `axum::response::Html` or a static template string.
- `sanitizeUrl()` in `morgan` logging — implement as a custom `tracing` formatter.
- The `/api/run` 202-then-async pattern (`res.json(...)` before `await runPipeline()`) — use
  `tokio::spawn` for the pipeline task and return immediately.

---

### Phase 3: Pipeline Logic (2.5 weeks)

**Goal**: Port the pure Rust logic — filter, scorer, classifier, generators.

**filter.rs** (from `src/pipeline/filter.ts`):
- All regex patterns compile with the `regex` crate. Devanagari Unicode ranges (`[ऀ-ॿ]`) work.
- `franc` → `whatlang::detect_script()` + `whatlang::detect()`. The Marathi marker lists and
  Roman-Marathi patterns dominate the decision — `whatlang` is only the fallback.
- Jaccard similarity (deduplication) is ~10 lines and trivially ports.

**scorer.rs** (from `src/pipeline/scorer.ts`):
- Pure arithmetic. 90 lines. Ports in 1–2 hours. Use `f64` throughout.

**generator.rs** (from `src/pipeline/generator.ts`):
- Use `async-openai` with `with_api_base("https://api.groq.com/openai/v1")`.
- The two large system prompt strings (`SYSTEM_PROMPT_PUNE`, `SYSTEM_PROMPT_GENERAL`) → Rust `const str` or `lazy_static`.
- `logPromptToConsole` → `tracing::debug!` or `tracing::info!`.
- The `enforceReplyLimit` function that uses `Array.from(trimmed)` (iterates Unicode codepoints, not bytes) — in Rust, use `str::chars().count()` and `str::char_indices()`. Don't use `.len()` (byte count).

**classifier.rs** (from `src/pipeline/classifier.ts`):
- Same `async-openai` call pattern.
- JSON response parsing: the classifier returns a raw JSON string from the model. Use `serde_json::from_str` with a typed struct.
- Browser profile fetch (`fetchProfile` → `classifyAccount`) requires the browser sidecar call.

**topic_categories.rs** (from `src/pipeline/topic_categories.ts`):
- Weighted random selection. Use `rand::Rng` with a weights lookup. Trivial port.

---

### Phase 4: Context / RAG Layer (3 weeks)

**Goal**: Port the RSS/Reddit/weather ingest, Voyage embeddings, vector store, retriever, neural memory, and trends.

**voyage.rs** (from `src/context/embeddings/voyage.ts`):
- The rate limiter uses a promise-chain to serialize requests. In Rust:
  ```rust
  struct VoyageEmbeddings {
      api_key: String,
      dim: usize,
      next_slot: Arc<tokio::sync::Mutex<tokio::time::Instant>>,
      min_interval: Duration,
  }
  ```
  Acquire the lock, sleep if needed, release lock, make HTTP call. Same semantics.
- HTTP call: `reqwest::Client::post(ENDPOINT).json(&body).bearer_auth(key).send()`.
- Response: `data[].embedding` → `Vec<f32>` → then cast to `[f32; N]` or keep as `Vec<f32>` for the buffer.
- The vec0 SQL binding expects a raw blob (4 bytes per float, little-endian). Use `bytemuck::cast_slice` to convert `&[f32]` to `&[u8]`.

**store.rs** (from `src/context/store/store.ts`):
- SHA-256 via `sha2` crate. `Digest::digest(body.as_bytes())` → hex via `hex::encode`.
- The near-duplicate vector check and insertion happen inside a `rusqlite` transaction. Use `conn.execute_batch("BEGIN; ...COMMIT")` or `conn.transaction()`.
- Buffer construction: `rusqlite::types::Value::Blob(bytes)` for the embedding param.

**neural_memory.rs** (from `src/context/neural_memory.ts`):
- This is pure in-memory graph computation over DB rows. The math (`recencyWeight`, `engagementWeight`,
  `recallFromMemory` scoring) ports directly.
- The ` ` key separator between node pairs: use `format!("{}\0{}", from, to)` in Rust.
- The STOPWORDS set: `once_cell::sync::Lazy<HashSet<&'static str>>`.

**sources/rss.rs** (from `src/context/sources/rss.ts`):
- `feed-rs::parser::parse()` handles both RSS and Atom. It's tolerant of malformed XML.
- The `relaxXml` fallback (bare ampersand escaping): use `str::replace("&", "&amp;")` on the raw
  response when feed-rs fails, then re-parse. Same logic.
- Content-type check to detect HTML-instead-of-RSS redirects: read `response.headers().get("content-type")`.

**sources/reddit.rs**:
- Pure `reqwest` GET + `serde_json` deserialization. Define a `RedditResponse` struct. Trivial.

**sources/weather.rs**:
- Same pattern. Define `WttrResponse` struct matching the wttr.in JSON format.

---

### Phase 5: Scheduler (1.5 weeks)

**Goal**: Port the four schedulers (pipeline, original posts, follower sync, context ingest) to Tokio tasks.

The TypeScript schedulers use `setInterval` + `setTimeout` — not cron for the main pipeline but
randomized daily windows. In Rust:

```rust
// Random slots: pre-compute a Vec<Instant> at startup for the day,
// then sleep until each one fires.
async fn run_daily_slot_scheduler(mut slots: Vec<tokio::time::Instant>, callback: impl Fn()) {
    for slot in slots {
        tokio::time::sleep_until(slot).await;
        callback();
    }
}
```

The `ensureTodayOriginalPlan()` pattern (idempotent plan creation at midnight) can be handled by a
daily reset task or by checking the DB at tick time (the current approach). Keep the tick-based
approach — it's simpler.

Use `tokio::select!` for clean shutdown of all scheduler tasks via a `CancellationToken`.

---

### Phase 6: Browser Automation (4–8 weeks, with options)

**Option A (Recommended): Node.js Browser Sidecar**

Keep the entire `src/browser/` directory as a minimal Node.js HTTP service running on `localhost:3001`.
The Rust binary sends HTTP requests to it:

```
POST /browser/ingest            → returns Vec<RawTweet> as JSON
POST /browser/post-reply        → body: {tweet_url, reply_text} → returns {reply_tweet_id}
POST /browser/post-original     → body: {content} → returns {tweet_id, tweet_url}
GET  /browser/profile/:handle   → returns {bio, follower_count, ...}
POST /browser/follow/:handle    → returns {ok}
GET  /browser/impressions       → body: {tweet_url} → returns {likes, replies, retweets}
GET  /browser/session/status    → returns {logged_in: bool}
```

The sidecar is ~300 lines of new Express code wrapping the existing browser modules. Zero logic
changes. Stealth continues to work. This gives you 80% of the benefits of Rust migration (binary
simplicity, low memory for the Rust core) while keeping the one irreplaceable TypeScript piece.

**Total additional work**: 1–2 weeks to write the sidecar HTTP wrapper.

**Option B: chromiumoxide (Pure Rust, accept detection risk)**

Use `chromiumoxide` 0.7 to speak CDP directly to a Chrome instance. You would need to:
1. Launch Chrome with the same args as the current `session.ts` (disable-blink-features, etc.)
2. Manually inject stealth patches via `Page.addScriptToEvaluateOnNewDocument`
3. Re-implement all 6 browser modules (~1,087 lines) against the chromiumoxide API

The stealth patches would need to be maintained as you'd be reimplementing what the stealth plugin does.
X is actively adversarial. **Estimated time: 6–10 weeks. Detection probability: high within weeks.**

**Option C: Hybrid — chromiumoxide for low-risk operations, sidecar for posting**

Profile fetching and impression scraping don't post anything — less risk if detected. Posting/replying
(which you need to work reliably) stays in the stealth Node.js sidecar. Complex to maintain two paths.

---

### Phase 7: Frontend (0 weeks)

The `public/` directory contains the D3.js dashboard. **It stays exactly as-is.** The Rust backend
serves it as static files via `tower_http::services::ServeDir`. API contracts are preserved — same
routes, same JSON shapes, same HTTP status codes. The frontend is completely transparent to the migration.

---

## 8. Effort Estimate

Estimates assume one experienced Rust developer, with good familiarity with the TS codebase.

| Phase | Scope | Estimate |
|---|---|---|
| Phase 1: Storage | db.rs + 3 query modules | **1.5–2 weeks** |
| Phase 2: HTTP API | axum + all route handlers | **1–1.5 weeks** |
| Phase 3: Pipeline | filter, scorer, classifier, generators | **2–3 weeks** |
| Phase 4: Context/RAG | voyage, store, retriever, neural memory, 3 sources, ingest, health, trends | **2.5–3.5 weeks** |
| Phase 5: Scheduler | 4 schedulers, Tokio tasks | **1–1.5 weeks** |
| Phase 6A: Browser Sidecar | Node.js HTTP wrapper (recommended) | **1–1.5 weeks** |
| Phase 6B: Pure chromiumoxide | CDP re-implementation + stealth | **6–10 weeks** |
| Phase 7: Frontend | Nothing — stays JS | **0 weeks** |
| Integration & Testing | End-to-end, live X testing | **1–2 weeks** |

**Total with Option A (sidecar)**: **~10–14 person-weeks**

**Total with Option B (full Rust browser)**: **~16–24 person-weeks** (and ongoing maintenance)

---

## 9. Risk Matrix

| Risk | Probability | Impact | Mitigation |
|---|---|---|---|
| X bot detection after migration | High (Option B) / Low (Option A) | Loss of core functionality | Use sidecar (Option A). Accept that X can always change detection. |
| `sqlite-vec` static linking issues | Medium | Lose semantic search; context layer degrades gracefully | Fall back to `.dylib` loading; app already handles this case |
| `feed-rs` can't parse Loksatta's malformed RSS | Medium | One source drops out | The TS code already has a tolerant fallback; port that too |
| `async-openai` vs Groq API compatibility | Low | LLM calls fail | Groq documents OpenAI compatibility; test against `llama-3.3-70b-versatile` before cutting over |
| `whatlang` Marathi detection quality | Low | Language filtering degrades slightly | The dominant code path is the hand-crafted marker lists, not whatlang |
| Voyage rate limiter correctness | Medium | Embedding calls fail / get 429d | Write targeted tests for the rate limiter using mock timers |
| Rust compilation times slow development | Low (single crate) / Medium (workspace) | Slower iteration | Keep as a single crate until proven otherwise; use `mold` linker |
| Data migration of existing `.db` | Low | No data migration needed | The schema stays identical; the same `.db` file just opens with a different binary |
| Novel Rust bugs in unsafe sqlite-vec FFI | Low | Segfault on DB operations | Wrap in `catch_unwind`, test thoroughly, the TS code already handles load failure gracefully |

---

## 10. Recommendation — Honest Verdict

**Don't do a full migration. The ROI is negative for a personal tool.**

Here is the breakdown:

**What you actually gain from migrating:**
- ~30–50 MB less memory for the Rust core (Chromium still eats 500+ MB)
- A single Rust binary for everything except the browser sidecar
- Faster compile feedback during development (debatable — tsc is fast too)
- Personal Rust practice

**What you pay:**
- 10–14 person-weeks of engineering work — that's 2–3 months of evenings and weekends
- Ongoing maintenance of two language runtimes (Rust + Node.js sidecar)
- Every time X changes its DOM, you fix it in the Node.js sidecar the same as today

**The real bottlenecks** in this app are:
1. Playwright browser rendering: 10–30s per ingest run — unaffected by rewriting the rest in Rust
2. Groq API latency: 1–3s per generation call — network-bound, Rust doesn't help
3. Voyage API latency: 0.5–1s per embedding call + self-throttling — rate-limited by design

The code that Rust would genuinely speed up — the scorer, filter, topic detection, neural memory
graph traversal — already runs in under 1ms in TypeScript. It does not appear in any profile.

### If You Still Want to Do It

**Best path**: Option A hybrid. Rewrite everything except `src/browser/` in Rust. Keep the browser
layer as a localhost HTTP sidecar. This is the only option that:
1. Doesn't increase X detection risk
2. Gives a meaningful reduction in complexity (single Rust binary + one small Node.js file)
3. Is achievable in a reasonable timeframe

Suggested order of operations, if you proceed:
1. Start with Phase 1 (storage) and write comprehensive tests against your real `.db` file.
2. Phase 3 (pipeline logic) second — it's self-contained, pure functions, easy to test.
3. Phase 2 (API) last before the sidecar — validate the dashboard works end-to-end.
4. Phases 4 and 5 can run in parallel once the foundation is solid.
5. Phase 6A (sidecar) is a 1-week finishing step, not the crux.

### Alternative: Stay TypeScript, but Run It Better

If the goal is lower memory and simpler deployment without 3 months of migration work:
- **Bun** instead of Node.js: 30–50% less memory, faster startup, identical code
- **PM2** or **systemd** for process management: solves restarts/monitoring
- **Docker**: solves the "single deployable unit" need without rewriting anything

These are 1-day changes that achieve much of the deployment simplicity that a Rust migration would.

---

*Plan based on full read of all 7,888 lines across 35+ source files. May 2026.*
