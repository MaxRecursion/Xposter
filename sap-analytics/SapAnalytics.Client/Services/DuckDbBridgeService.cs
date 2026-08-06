using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.JSInterop;
using SapAnalytics.Data.Sync;

namespace SapAnalytics.Client.Services;

public sealed class DuckDbBridgeService : IDuckDbBridge
{
    private static readonly JsonSerializerOptions QueryJsonOptions = new()
    {
        PropertyNameCaseInsensitive = true
    };

    private readonly IJSRuntime _js;
    private readonly EntityCatalogService _catalog;

    public DuckDbBridgeService(IJSRuntime js, EntityCatalogService catalog)
    {
        _js = js;
        _catalog = catalog;
    }

    public async Task InitializeAsync(CancellationToken cancellationToken = default)
    {
        await _js.InvokeVoidAsync("SapAnalyticsBridge.initialize", cancellationToken);
    }

    public async Task RegisterDatasetAsync(string entityId, string opfsPath, string format, CancellationToken cancellationToken = default)
    {
        await _js.InvokeVoidAsync("SapAnalyticsBridge.registerDataset", cancellationToken, entityId, opfsPath, format);
    }

    public async Task RefreshMaterializedViewsAsync(CancellationToken cancellationToken = default)
    {
        var catalog = await _catalog.GetCatalogAsync(cancellationToken);
        var statements = SapAnalytics.Query.MaterializedViewDefinitions.BuildRefreshSql(catalog);
        await _js.InvokeVoidAsync("SapAnalyticsBridge.refreshMaterializedViews", cancellationToken, statements);
    }

    public async Task<long> ExecuteScalarLongAsync(string sql, CancellationToken cancellationToken = default)
    {
        var value = await _js.InvokeAsync<double>("SapAnalyticsBridge.scalarLong", cancellationToken, sql);
        return Convert.ToInt64(value);
    }

    public async Task<DuckDbQueryPayload> QueryAsync(string sql, CancellationToken cancellationToken = default)
    {
        var json = await _js.InvokeAsync<string>("SapAnalyticsBridge.queryJson", cancellationToken, sql);
        var dto = JsonSerializer.Deserialize<DuckDbQueryPayloadJson>(json, QueryJsonOptions)
            ?? throw new InvalidOperationException("DuckDB query returned empty payload.");
        return new DuckDbQueryPayload
        {
            Columns = dto.Columns,
            Rows = dto.Rows
                .Select(row => row.Select(FromJsonElement).ToList())
                .ToList(),
            ElapsedMs = dto.ElapsedMs
        };
    }

    public async Task LoadSampleDataAsync(CancellationToken cancellationToken = default)
    {
        await _js.InvokeVoidAsync("SapAnalyticsBridge.loadSampleData", cancellationToken);
    }

    public async Task<long?> GetJsHeapUsedAsync(CancellationToken cancellationToken = default)
    {
        return await _js.InvokeAsync<long?>("SapAnalyticsBridge.getJsHeapUsed", cancellationToken);
    }

    private static object? FromJsonElement(JsonElement element) => element.ValueKind switch
    {
        JsonValueKind.Null or JsonValueKind.Undefined => null,
        JsonValueKind.String => element.GetString(),
        JsonValueKind.Number when element.TryGetInt64(out var i) => i,
        JsonValueKind.Number => element.GetDouble(),
        JsonValueKind.True => true,
        JsonValueKind.False => false,
        _ => element.GetRawText()
    };

    private sealed class DuckDbQueryPayloadJson
    {
        [JsonPropertyName("columns")]
        public List<string> Columns { get; set; } = [];

        [JsonPropertyName("rows")]
        public List<List<JsonElement>> Rows { get; set; } = [];

        [JsonPropertyName("elapsedMs")]
        public long ElapsedMs { get; set; }
    }
}
