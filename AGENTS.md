# Xposter AI Agent Instructions

## What this repo is

Xposter is a local TypeScript automation project for X/Twitter. It runs:
- an Express dashboard + REST API (`src/api/`)
- scheduled automation jobs (`src/scheduler/`)
- Playwright browser automation for timeline ingestion, reply posting, follower sync, and impressions
- a local SQLite datastore (`data/xposter.db`) with optional vector search
- optional Claude/Anthropic agent workflows in `src/agent/`

Use this file to understand repository structure, runtime conventions, and safe editing patterns.

## Primary tasks for an AI assistant

- preserve `.env` and secret handling: `.env.example` documents runtime config, but actual secrets are not stored in source control
- prefer `npm run setup` before local work: installs deps, Playwright browsers, and creates `.env` if missing
- make changes in `src/` and `public/`; treat `data/`, `browser-profile/`, `logs/`, and `dist/` as runtime/artifacts
- run tests before finalizing changes: `npm test`, `npm run test:watch`, `npm run test:coverage`

## Key commands

- `npm run setup` — install dependencies, install Playwright Chromium, copy `.env.example` to `.env`
- `npm run dev` — start the app in watch mode via `tsx watch src/index.ts`
- `npm run build` — compile TypeScript with `tsc`
- `npm start` — run built app from `dist/index.js`
- `npm test` — run Vitest tests
- `npm run install:browsers` — install Playwright browsers

## Important files and directories

- `src/index.ts` — application entrypoint
- `src/env.ts` — environment load and validation
- `src/storage/db.ts` — SQLite schema and DB initialization
- `src/scheduler/cron.ts` — scheduled jobs and runtime orchestration
- `src/browser/session.ts` — Playwright browser session, login cookie handling, profile path
- `src/pipeline/` — reply/original post generation logic and RAG/source pipelines
- `src/api/` — Express server routes and dashboard API
- `src/agent/` — optional code-maintenance agent logic, prompts, policies, worktree support
- `public/` — dashboard frontend assets
- `scripts/` — standalone helpers for trend/image probes and searches

## Runtime conventions

- runtime config is driven by `.env` and values from the settings table in the DB
- browser automation uses a persistent user profile in `browser-profile/`
- X auth is provided via env vars `X_AUTH_TOKEN` and `X_CT0`; the repo does not rely on automated login
- `BROWSER_HEADLESS` controls headless mode; defaults support local macOS execution
- `CONTEXT_ENABLED=false` by default; RAG/context ingestion is optional and gated by env config
- `AGENT_ENABLED=true` enables the self-healing agent subsystem, but agent runs are optional and guarded by settings
- `tsconfig.json` uses `module: NodeNext` and ES modules; imports should follow ESM conventions

## Test guidance

- `tests/` contains both `integration/` and `unit/` tests
- common focus areas for changes:
  - `tests/unit/` for business logic in `src/pipeline/`, `src/utils/`, `src/context/`
  - `tests/integration/` for end-to-end behavior between browser logic, scheduler, and API routes
- changes that affect runtime behavior should include appropriate tests

## Safe editing guidance

- do not commit or expose secrets from `.env` or `browser-profile/`
- avoid editing runtime artifacts: `data/`, `logs/`, `browser-profile/`, `dist/`
- do not modify `package-lock.json` unless dependency changes are required
- prefer linking to existing docs rather than copying large sections from `README.md` or `DEPLOY.md`

## Useful documentation links

- `README.md` — project overview, setup, and architecture
- `.env.example` — runtime configuration and environment requirements
- `DEPLOY.md` — deployment and runtime notes

## What to watch for

- many flows depend on Playwright selectors and X page structure; browser automation changes can be fragile
- the agent code in `src/agent/` is a separate subsystem: use it only when the task explicitly involves agent workflows
- the project assumes local macOS execution with optional Tailscale callback support for ntfy actions
- `src/storage/db.ts` uses `better-sqlite3`; schema evolution is handled at startup and should be preserved carefully
