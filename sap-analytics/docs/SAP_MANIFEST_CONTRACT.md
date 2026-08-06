# SAP Snapshot Export — Integration Guide

This document defines the contract between SAP export jobs and the Blazor client sync pipeline.

## Deliverables per snapshot cycle

1. **Partitioned data files** — Parquet (preferred, ZSTD) or CSV per entity
2. **Manifest JSON** — describes version, checksums, row counts, download URLs

## Manifest schema

Full JSON Schema: `SapAnalytics.Client/wwwroot/schemas/manifest-schema.json`

### Required manifest fields

| Field | Description |
|-------|-------------|
| `version` | Unique snapshot id (e.g. `2026-08-05T00:00:00Z`) |
| `schemaVersion` | Entity catalog version (`1.0`) |
| `exportedAt` | ISO-8601 timestamp |
| `tables[]` | File manifest per entity |

### Per-table file entry

| Field | Description |
|-------|-------------|
| `entityId` | Matches entity catalog id (`transactions`, `companies`, …) |
| `fileName` | File name within snapshot bundle |
| `downloadUrl` | HTTPS URL or authenticated API endpoint |
| `byteSize` | Exact file size in bytes |
| `rowCount` | Row count for validation |
| `checksumSha256` | SHA-256 hex digest of file bytes |
| `partitionKey` | Optional partition label (`2024-01`, `company=123`) |
| `format` | `parquet` or `csv` |
| `compression` | `zstd`, `snappy`, `gzip`, or `none` |

## Export recommendations

- Partition large fact tables by **period** and **company** where possible
- Use **ZSTD level 3** for Parquet exports
- Publish manifest only after all files are complete and checksummed
- Mark `breakingSchemaChange: true` when removing/renaming columns

## Client sync behavior

1. Download files to OPFS staging path `snapshots/staging/{version}/`
2. Verify checksum and byte size
3. Promote to `snapshots/active/{version}/`
4. Register in DuckDB-WASM, refresh materialized views
5. Build Tier 1 JSON cache, flip active pointer
6. Delete generations older than N-1

## Authentication

Browser `fetch` from Blazor WASM must be able to reach `downloadUrl` with corporate SSO/OAuth bearer tokens. Coordinate CORS and token forwarding with the API gateway team.
