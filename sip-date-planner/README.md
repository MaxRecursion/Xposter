# SIP Date Planner

Static SvelteKit app that answers: **which date of the month should I run my SIP for fund X?**

The date is a scheduling convenience, not an alpha source. Typical best-versus-worst XIRR spread is about **0.1 percentage points** over 13+ years. The UI always names a concrete day inside your salary safe window, then grades its own confidence (`noise` / `marginal` / `meaningful`).

## Stack

SvelteKit (`adapter-static`) · TypeScript · Tailwind CSS · uPlot · Vitest · Node 22 build pipeline. No backend, no database, no accounts.

## Two halves

1. **`pipeline/`** — nightly GitHub Action downloads NAVs from [mfapi.in](https://www.mfapi.in/), filters Direct Growth open-ended schemes, simulates SIP dates 1–28, writes `/static/data`.
2. **`src/`** — prerendered site. Search loads `index.json` on first keystroke; the answer is one ~1.5 KB JSON file. Analysis never runs in the browser.

```sh
pnpm install
pnpm test
pnpm pipeline:kotak   # one real fund + short-history fixture
pnpm dev
```

Full universe (expect 20 minutes on a GitHub runner):

```sh
pnpm pipeline
```

## URL state

`/f/{schemeCode}?salary=28&buffer=2` — `salary=28` means last working day (safe window **3rd–12th**). An explicit day `s` uses `s+buffer` through `s+buffer+9`, wrapped onto 1–28.

## Deploy

Cloudflare Pages: build `pnpm build`, output `build/`. `_headers` sets immutable cache on `/data/funds/*` and one-hour cache on the search index.
