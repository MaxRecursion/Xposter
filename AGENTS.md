# Xposter AI Agent Instructions

## What this repo is

Xposter is a local TypeScript automation project for X/Twitter (macOS). It runs:
- an Express dashboard + REST API (`src/api/`, UI in `public/`)
- scheduled automation jobs (`src/scheduler/`)
- Playwright browser automation for timeline ingestion, posting, follower sync, likes, and impressions (`src/browser/`)
- reply + original-post generation pipelines (`src/pipeline/`)
- optional AI image posts with provider fallback + vision QA (`src/images/`)
- X trends helpers (`src/trends/`)
- a local SQLite datastore (`data/xposter.db`) with optional Voyage embeddings / RAG (`src/context/`)
- optional Claude/Anthropic self-healing agent workflows (`src/agent/`)
- ntfy iPhone notifications with signed action callbacks (`src/notifications/`)

## Primary tasks for an AI assistant

- preserve `.env` and secret handling: `.env.example` documents runtime config; never commit secrets
- prefer `npm run setup` before local work: installs deps, Playwright Chromium, and creates `.env` if missing
- make changes in `src/` and `public/`; treat `data/`, `browser-profile/`, `logs/`, `Backups/`, and `dist/` as runtime/artifacts
- read typed config via `src/config.ts` getters (and DB settings via `src/storage/settings.ts`), not ad-hoc `process.env` reads in call sites
- run tests before finalizing behavior changes: `npm test` (also `npm run test:watch`, `npm run test:coverage`)

## Key commands

- `npm run setup` — install dependencies, install Playwright Chromium, copy `.env.example` to `.env`
- `npm run dev` — start the app in watch mode via `tsx watch src/index.ts`
- `npm run build` — compile TypeScript with `tsc`
- `npm start` — run built app from `dist/index.js`
- `npm test` — run Vitest tests
- `npm run install:browsers` — install Playwright browsers
- `npm run trends:probe` / `npm run trends:search` — trend debugging scripts
- `npm run image:probe` / `npm run image:anchor` — image provider / style-anchor helpers

## Important files and directories

- `src/index.ts` — entrypoint (loads `env.js` first, boots DB + API + scheduler)
- `src/env.ts` — dotenv load (must stay first import in entrypoint)
- `src/config.ts` — typed env accessors (ports, browser, LLM, image/fal/gemini, agent, etc.)
- `src/storage/db.ts` — SQLite schema + startup migrations (`addColumnIfMissing` pattern)
- `src/storage/settings.ts` — runtime settings stored in SQLite
- `src/scheduler/cron.ts` — starts/stops all scheduled jobs
- `src/pipeline/reply_pipeline.ts` — reply ingest → filter → score → generate → ntfy → post
- `src/pipeline/original_post_generator.ts` — original post drafting
- `src/browser/session.ts` — Playwright persistent profile / login cookies
- `src/images/generator.ts` — scene pick, provider chain, retry ladder
- `src/images/providers/` — fal, gemini, openai, huggingface, pollinations (+ `fal_references.ts`)
- `src/images/vision_qa.ts` / `anchors.ts` / `captions.ts` — QA gate, style anchors, captions
- `src/scheduler/image_posts.ts` — evening image-post schedule (`scheduled_runs` kind `IMAGE_POST`)
- `src/trends/` — X trend fetch/filter used by reply/original/image flows
- `src/api/` — Express server + route modules under `src/api/routes/`
- `src/agent/` — optional code-maintenance agent (watcher, investigator, implementer, worktrees)
- `public/` — dashboard SPA assets
- `scripts/` — standalone trend/image probes
- `tests/unit/` + `tests/integration/` — Vitest suites

## Runtime conventions

- package is ESM (`"type": "module"`); TypeScript uses `module`/`moduleResolution: NodeNext` — keep `.js` extensions on relative imports
- runtime config is `.env` + SQLite `settings` table (dashboard can mutate many knobs)
- browser automation uses persistent profile `browser-profile/` (`BROWSER_USER_DATA_DIR`)
- X auth cookies via `X_AUTH_TOKEN` and `X_CT0`; no automated login flow
- `BROWSER_HEADLESS` defaults true; set false for manual login recovery
- `CONTEXT_ENABLED=false` by default; RAG/context ingest is optional
- `AGENT_ENABLED` gates the self-healing agent; runs are further limited by settings/budgets
- image providers are an ordered fallback chain; `IMAGE_PROVIDER` can promote one; paid providers respect monthly budget (`src/storage/image_budget.ts`)
- fal is the preferred paid image path when `FAL_KEY` is set; Gemini/OpenAI/HF/Pollinations remain in the chain
- image posts are gated by vision QA — reject-all means skip posting that slot
- schema evolution belongs in `src/storage/db.ts` startup migrations; preserve additive/`IF NOT EXISTS` style

## Test guidance

- prefer `tests/unit/` for pure logic (pipeline, images, trends, storage helpers, agent policy)
- use `tests/integration/` for API routes and cross-module flows
- image-related work should cover providers, budget, uploads/references, and retry/QA behavior when touched
- do not require live API keys in unit tests; mock network/provider boundaries

## Safe editing guidance

- do not commit or expose secrets from `.env` or `browser-profile/`
- avoid editing runtime artifacts: `data/`, `logs/`, `browser-profile/`, `Backups/`, `dist/`
- do not modify `package-lock.json` unless dependency changes are required
- prefer linking to existing docs over copying large sections from `README.md` or `DEPLOY.md`
- Playwright selectors against x.com are fragile — prefer minimal, well-tested DOM changes
- keep `src/agent/` changes scoped to agent tasks; it is a separate subsystem

## Useful documentation

- `README.md` — product overview, architecture, setup, API/scheduler notes
- `.env.example` — full environment reference (including image/fal/gemini and agent knobs)
- `DEPLOY.md` — local launchctl restart / deploy notes
- `docs/` — feature plans, diagrams, security notes (some may be historical)

## What to watch for

- many flows depend on Playwright selectors and X page structure
- dashboard mutations go through `src/api/auth.ts` (API key and/or trusted dashboard origin)
- ntfy callbacks need a reachable `CALLBACK_BASE_URL` / Tailscale path from the phone
- image spend and upload TTL are first-class concerns when changing fal/reference behavior
- `DEPLOY.md` may lag provider defaults; treat `.env.example` + `src/images/providers/` as source of truth for image config
