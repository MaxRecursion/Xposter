using SapAnalytics.Core.Cache;
using SapAnalytics.Core.Query;
using SapAnalytics.Core.Sync;
using SapAnalytics.Core.Views;
using SapAnalytics.Data.Sync;
using SapAnalytics.Query;

namespace SapAnalytics.Client.Services;

public sealed class TieredQueryService
{
    private readonly IOpfsStorage _opfs;
    private readonly IDuckDbBridge _duckDb;
    private readonly EntityCatalogService _catalog;
    private readonly SqlGenerator _sqlGenerator = new();
    private Tier1SnapshotBundle? _tier1Cache;

    public TieredQueryService(IOpfsStorage opfs, IDuckDbBridge duckDb, EntityCatalogService catalog)
    {
        _opfs = opfs;
        _duckDb = duckDb;
        _catalog = catalog;
    }

    public async Task<Tier1SnapshotBundle?> GetTier1CacheAsync(CancellationToken cancellationToken = default)
    {
        if (_tier1Cache is not null) return _tier1Cache;
        var json = await _opfs.ReadTextAsync(SnapshotPathBuilder.Tier1CacheFile, cancellationToken);
        if (json is null) return null;
        _tier1Cache = Tier1CacheSerializer.Deserialize(json);
        return _tier1Cache;
    }

    public void InvalidateTier1Cache() => _tier1Cache = null;

    public async Task<QueryResult> ExecuteViewAsync(
        ViewDefinition view,
        bool forceSql = false,
        CancellationToken cancellationToken = default)
    {
        if (!forceSql && view.Tier1CacheKey is not null)
        {
            var cache = await GetTier1CacheAsync(cancellationToken);
            var entry = cache?.Entries.GetValueOrDefault(view.Tier1CacheKey);
            if (entry is not null)
            {
                return MapTier1Entry(entry, cache!.GeneratedAt);
            }
        }

        if (!forceSql && view.MaterializedViewName is not null)
        {
            var mvSql = $"SELECT * FROM {view.MaterializedViewName} LIMIT {view.PreviewLimit}";
            var mvResult = await _duckDb.QueryAsync(mvSql, cancellationToken);
            return MapDuckPayload(mvResult, "Tier2");
        }

        var catalog = await _catalog.GetCatalogAsync(cancellationToken);
        var sql = _sqlGenerator.Generate(view, catalog);
        var payload = await _duckDb.QueryAsync(sql, cancellationToken);
        return MapDuckPayload(payload, "Tier3");
    }

    private static QueryResult MapDuckPayload(DuckDbQueryPayload payload, string tier)
    {
        return new QueryResult
        {
            Columns = payload.Columns.Select(c => new QueryColumn { Name = c }).ToList(),
            Rows = payload.Rows.Select(r => new QueryRow { Values = r }).ToList(),
            ElapsedMs = payload.ElapsedMs,
            SourceTier = tier
        };
    }

    private static QueryResult MapTier1Entry(Tier1SnapshotEntry entry, DateTime generatedAt)
    {
        if (entry.Table is not null)
        {
            var columns = entry.Table.Headers.Select(h => new QueryColumn { Name = h }).ToList();
            var rows = entry.Table.Rows
                .Select(r => new QueryRow { Values = r.Cast<object?>().ToList() })
                .ToList();
            return new QueryResult
            {
                Columns = columns,
                Rows = rows,
                ElapsedMs = 0,
                SourceTier = "Tier1"
            };
        }

        return new QueryResult
        {
            Columns = new[] { new QueryColumn { Name = "value" } },
            Rows = new[]
            {
                new QueryRow { Values = new object?[] { entry.Kpi?.Value ?? entry.Chart?.Title ?? entry.Key } }
            },
            ElapsedMs = 0,
            SourceTier = "Tier1"
        };
    }
}
