# SAP Analytics — Client-Side Reporting Platform

Blazor WebAssembly + OPFS + DuckDB-WASM foundation for SAP management reporting.

## Stack

- **UI:** Blazor WebAssembly (.NET 11 preview)
- **Local store:** OPFS (Parquet/CSV snapshot files)
- **Query engine:** DuckDB-WASM (Web Worker via JS interop)
- **Sync:** Versioned full snapshots with atomic flip
- **Caching:** Tier 1 JSON snapshots · Tier 2 materialized views · Tier 3 ad hoc SQL

## Projects

| Project | Role |
|---------|------|
| `SapAnalytics.Client` | Blazor WASM UI, JS bridge, pages |
| `SapAnalytics.Core` | Manifest, metadata, view models, retention |
| `SapAnalytics.Data` | Sync orchestration, Tier 1 cache builder |
| `SapAnalytics.Query` | Safe SQL generator, materialized view defs |
| `SapAnalytics.Host` | Static host with COOP/COEP headers |
| `SapAnalytics.Tests` | Unit tests |

## Run locally

```bash
export DOTNET_ROOT=~/.dotnet PATH=~/.dotnet:$PATH
cd sap-analytics
dotnet workload install wasm-tools   # once
dotnet run --project SapAnalytics.Host
```

Open the URL shown (typically `http://localhost:5000`). Use **Chrome or Edge** for full OPFS + DuckDB support.

## First-time data load

1. Open **Data Sync** → **Sync sample snapshot** (50k transactions from bundled CSV).
2. Open **Dashboard** for Tier 1 KPIs/charts.
3. Open **Reports** for predefined Tier 2/3 views.
4. Open **Benchmarks** to run the query performance suite.

## SAP integration contract

See `SapAnalytics.Client/wwwroot/schemas/manifest-schema.json` for the snapshot manifest SAP should publish with each export.

## Scale testing

```bash
node scripts/generate-large-dataset.mjs 10000000
```

Update `manifest-sample.json` with new checksums and file names, then sync.

## Architecture notes

- DuckDB runs in a dedicated browser worker — not .NET native bindings.
- Never hold millions of rows in the Blazor managed heap; query results are capped (default 200 rows).
- Retention tiers (hot/warm/cold) are defined in `schemas/retention-policy.json`.
