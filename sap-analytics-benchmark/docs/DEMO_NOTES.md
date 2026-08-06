# Senior Leadership Demo — Blazor WASM + DuckDB Benchmark

## 3-minute elevator pitch

> **The problem:** Management reporting through SAP WebI costs *minutes* per interaction. Nobody explores data; they file requests.
>
> **The proposal:** Sync SAP data once, store it locally in the browser, query with DuckDB in WebAssembly — sub-second for most shapes, offline-capable, no server round-trip per drill.
>
> **What we measured:** On 1M rows (demo) scaling to 10M in production, duckdb-wasm delivers **400–1400 ms** queries vs WebI's **minutes**. The interop boundary costs single-digit milliseconds — the query engine is the bottleneck, not Blazor.
>
> **The decision:** Ship **V1 (duckdb-wasm + JS interop)** for production isolation. **V2** proves native DuckDB can compile against .NET’s Emscripten 3.1.56 and run via P/Invoke (shared heap trade-off). **V3 (.NET in Web Worker)** is the .NET 11 evolution for cleaner C# gateways.

---

## Live demo script (15 minutes)

### Setup (before the room)

1. Generate data: `node spikes/data/generate-dataset.mjs --rows=1000000`
2. Start V1: `dotnet run --project apps/WasmJsInterop/WasmJsInterop.csproj`
3. Have V2 and V3 URLs ready in separate tabs (ports will differ per launch).

### Act 1 — The pain (2 min)

- "WebI: change a filter → wait 2–5 minutes → lose your train of thought."
- "Our offline requirement means data must live in the browser. The question is *how* we query it."

### Act 2 — V1 recommended path (5 min)

1. Navigate to **`/assessment`**
2. Click **Run Full Benchmark Suite**
3. **Highlight timing waterfall:**
   - **Init + Load Data** — one-time cost loading 1M rows via `registerFileBuffer` (no `opfs://` db.open — Spike 1 lesson)
   - **Q1 Scan Agg** — ~300–500 ms (scale from Spike 1's 429 ms @ 8M)
   - **Q2 Time Series** — ~400–600 ms
   - **Q3 Join+Filter** — **call out honestly: may be 800–1400 ms** — "most ordinary report shape; rollups are load-bearing, not optional"
   - **Q4 Fork-Join** — ~500–800 ms
   - **Arrow/Interop Copy** — **single-digit ms** — "NOT the bottleneck"
4. Show **grid** (virtualized, 500 row cap) and **chart**
5. Click **Export Timing JSON** — "reproducible numbers for architecture review"

### Act 3 — V2 native P/Invoke (4 min)

1. Open V2 `/assessment`
2. Note: DuckDB C/C++ was built with **Emscripten 3.1.56** (same as .NET 10 wasm-tools) and linked via `NativeFileReference` — **no duckdb-wasm fallback**.
3. Run suite — show **real native** timings (shared .NET heap; MEMFS CSV ingest).
4. Discuss trade-offs: shared 1.5 GB heap with Mono GC; no sync OPFS I/O; larger download. V1 still preferred for production isolation.

### Act 4 — V3 evolution (3 min)

1. Open V3 `/assessment`
2. Explain: "C# calls `IQueryEngine` → worker gateway → duckdb-wasm in separate 4 GiB heap"
3. Run suite — compare worker round-trip overhead vs V1
4. ".NET 11 `blazorwebworker` puts C# *inside* the worker — JS interop confined to the worker boundary."

### Close (1 min)

- "V1 ships. V3 hardens the gateway. V2 is off the table."
- "Next gate: reconciliation golden set against frozen WebI snapshot."

---

## Expected results table

| Query | Wasm (1M est.) | Wasm (8M Spike 1) | Native (theoretical) | WebI |
|-------|----------------|-------------------|------------------------|------|
| Q1 Scan Agg | 200–450 ms | 429 ms | ~28 ms | minutes |
| Q2 Time Series | 300–550 ms | 549 ms | ~38 ms | minutes |
| Q3 Join+Filter | 600–1400 ms | **1357 ms** | ~36 ms | minutes |
| Q4 Fork-Join | 400–750 ms | 743 ms | ~64 ms | minutes |
| Interop copy (≤50k rows) | 1–20 ms | 6–18 ms | N/A | N/A |

**Gate:** Self-service ad-hoc over base fact = 0.4–1.4 s. Acceptable vs WebI; not "instant." Pre-computed rollups deliver 10–50 ms.

---

## Why V1 wins over V2 (native)

| Factor | V1 duckdb-wasm | V2 native P/Invoke |
|--------|----------------|-------------------|
| Separate heap | 4 GiB duckdb + 768 MB .NET | Shared ≤2 GiB |
| OPFS Parquet | `registerFileBuffer` / OPFS scan works | Sync I/O cannot await OPFS |
| Prior art | Production duckdb-wasm | Zero Blazor+native DuckDB |
| Fault isolation | Worker respawn on OOM | DuckDB OOM kills entire app |
| Build toolchain | Self-hosted wasm | Emscripten version deadlock |

---

## Why V3 is the evolution path

- Application code calls **`IQueryEngine` in C#** with `CancellationToken` — no JavaScript in business logic.
- duckdb-wasm stays in the **same worker** as the future .NET runtime instance.
- **No COOP/COEP required** for .NET-on-workers (unlike threaded duckdb `coi` build).
- Measured today: small worker round-trip tax vs cleaner architecture at scale.

---

## Honest limitations (say these proactively)

1. **Single-threaded `eh` build** — threading blocked by OPFS + extension LinkError (Spike 1).
2. **Q3 join may exceed 1 s** at full volume — rollup builder is milestone 1, not phase 2.
3. **OPFS durability** — `persist()` returned false in Spike 1; MDM policy audit is a go/no-go gate.
4. **First-run data load** — 1M CSV is ~80 MB; budget 30–60 s on laptop Wi-Fi for demo.
5. **V3 is a gateway spike** — full `WebWorkerClient` + `[JSExport]` C# in worker not yet wired.

---

## Reconciliation credibility (slide bullets)

1. Freeze one SAP extract — reconcile against WebI on that snapshot only.
2. Golden set: 50 top reports + 200 micro-cases (measure × hierarchy × fan-out shape).
3. Three-level compare: grand total, subtotals, row-level diff.
4. Pin rounding: DuckDB half-away-from-zero; currency at transaction row.
5. **`_legrows` invariant** — hard error on join inflation, not silent wrong numbers.
6. **"Explain this number"** — right-click → SQL, legs, snapshot id.

---

## FAQ for leadership

**Why not server-side?**  
Offline is required. Server adds latency, VPN dependency, and per-query cost. Local query turns exploration into a CPU operation.

**Why not native DuckDB in the browser?**  
Cannot link for browser-wasm; would share memory with .NET; cannot read OPFS. See V2 assessment.

**Does it work offline?**  
Yes, after initial sync. Data in OPFS/registered buffers; duckdb-wasm and app assets self-hosted.

**Security?**  
Data at rest accepted under FDE. Row-level security must be enforced at publish time — anyone with the file sees all rows. Scope snapshots per entitlement if needed.

**How do we trust the numbers?**  
Reconciliation program against frozen WebI snapshot; fan-out regression suite; stamped snapshot version on every export.

---

## Comparison export

Each `/assessment` page exports timing JSON. For side-by-side leadership slides, run all three variants and compare `queryMs` and per-step arrays.

Example filenames:
- `v1-timing.json`
- `v2-native-pin-timing.json`
- `v3-webworker-timing.json`
