# SAP Analytics Benchmark — Blazor WASM + DuckDB

Leadership demo comparing three Blazor WebAssembly integration approaches for client-side SAP analytics (1M heterogeneous rows).

## Prerequisites

```bash
export DOTNET_ROOT=~/.dotnet
export PATH=~/.dotnet:$PATH
dotnet workload install wasm-tools   # if not already installed
node --version                       # for dataset generation
```

SDKs used: **.NET 10** (V1, V2), **.NET 11 preview** (V3).

## Generate 1M-row dataset

```bash
cd sap-analytics-benchmark
node spikes/data/generate-dataset.mjs --rows=1000000
```

This writes CSV files to `spikes/data/out/` and symlinks them into each app's `wwwroot/data/`.

For a quick smoke test (10k rows):

```bash
node spikes/data/generate-dataset.mjs --rows=10000
```

## Run each variant

### V1 — duckdb-wasm via JS Interop (recommended)

```bash
DOTNET_ROOT=~/.dotnet PATH=~/.dotnet:$PATH \
  dotnet run --project apps/WasmJsInterop/WasmJsInterop.csproj
```

Or with COOP/COEP host:

```bash
DOTNET_ROOT=~/.dotnet PATH=~/.dotnet:$PATH \
  dotnet run --project Benchmark.Host/Benchmark.Host.csproj
```

Open `/assessment` → **Run Full Benchmark Suite**.

### V2 — Native DuckDB P/Invoke (matched Emscripten)

Build DuckDB with .NET’s pinned Emscripten **3.1.56** (once):

```bash
export DOTNET_ROOT=~/.dotnet
./apps/WasmNativePin/native-src/build-native.sh
```

Then run:

```bash
DOTNET_ROOT=~/.dotnet PATH=~/.dotnet:$PATH \
  dotnet run --project apps/WasmNativePin/WasmNativePin.csproj --urls http://localhost:5102
```

Queries run through P/Invoke against `libduckdb_native.a` (no duckdb-wasm fallback). CSV is loaded via MEMFS + `read_csv_auto`.

### V3 — .NET Web Worker gateway (.NET 11)

```bash
DOTNET_ROOT=~/.dotnet PATH=~/.dotnet:$PATH \
  dotnet run --project apps/WasmDotNetWorker/WasmDotNetWorker.csproj
```

`IQueryEngine` on main thread; duckdb-wasm runs in a dedicated worker with measurable boundary overhead.

## Tests

```bash
DOTNET_ROOT=~/.dotnet PATH=~/.dotnet:$PATH \
  dotnet test Benchmark.Tests/Benchmark.Tests.csproj
```

## Solution layout

| Path | Purpose |
|------|---------|
| `Benchmark.Core/` | Timing model, `IQueryEngine`, benchmark SQL, data schema |
| `Benchmark.Host/` | ASP.NET host with COOP/COEP/credentialless headers |
| `apps/WasmJsInterop/` | V1 reference implementation |
| `apps/WasmNativePin/` | V2 native DuckDB (Emscripten 3.1.56 + P/Invoke) |
| `apps/WasmDotNetWorker/` | V3 worker gateway pattern |
| `spikes/data/` | 1M-row CSV generator |
| `docs/DEMO_NOTES.md` | Senior leadership demo script |

## Known limitations

- First load of 1M-row `transactions.csv` takes time to fetch and ingest.
- V2 links DuckDB into the .NET WASM heap (shared memory; OPFS sync I/O still unavailable — use MEMFS/HTTP fetch).
- V3 uses a JS worker gateway; full `blazorwebworker` C#-in-worker is the .NET 11 evolution target.
- V1 duckdb-wasm JS bindings load from CDN; wasm binaries are self-hosted in `wwwroot/lib/duckdb-wasm/`.
- Q3 join+filter may exceed 1s at 1M rows (Spike 1: ~1.4s at 8M) — rollups required for instant UX.

See [docs/DEMO_NOTES.md](docs/DEMO_NOTES.md) for the live demo script.
