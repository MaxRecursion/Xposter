using System.Text.Json;
using System.Text.Json.Serialization;
using Benchmark.Core;
using Benchmark.Core.Query;
using Benchmark.Core.Timing;
using Microsoft.JSInterop;

namespace WasmJsInterop.Services;

public sealed class JsInteropQueryEngine : IQueryEngine
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true
    };

    private readonly IJSRuntime _js;

    public JsInteropQueryEngine(IJSRuntime js) => _js = js;

    public ApproachKind Approach => ApproachKind.WasmJsInterop;
    public bool IsReady { get; private set; }
    public string StatusMessage { get; private set; } = "Not initialized";

    public async Task InitializeAsync(CancellationToken cancellationToken = default)
    {
        var result = await _js.InvokeAsync<BridgeStatus>("BenchmarkBridge.initialize", cancellationToken);
        IsReady = result.Ok;
        StatusMessage = result.Message ?? "DuckDB-WASM ready (eh bundle, in-memory catalog).";
    }

    public async Task<BenchmarkRunResult> RunFullSuiteAsync(CancellationToken cancellationToken = default)
    {
        var json = await _js.InvokeAsync<string>("BenchmarkBridge.runFullSuite", cancellationToken);
        return JsonSerializer.Deserialize<BenchmarkRunResult>(json, BenchmarkJson.Options)
            ?? throw new InvalidOperationException("Empty benchmark result.");
    }

    public async Task<QueryResultSet> ExecuteBenchmarkQueryAsync(BenchmarkStepKind queryStep, CancellationToken cancellationToken = default)
    {
        var sql = BenchmarkQueries.GetSql(queryStep);
        return await QueryAsync(sql, cancellationToken);
    }

    private async Task<QueryResultSet> QueryAsync(string sql, CancellationToken cancellationToken = default)
    {
        var json = await _js.InvokeAsync<string>("BenchmarkBridge.queryJson", cancellationToken, sql);
        var dto = JsonSerializer.Deserialize<QueryPayloadJson>(json, JsonOptions)
            ?? throw new InvalidOperationException("Empty query payload.");

        return new QueryResultSet
        {
            Columns = dto.Columns,
            Rows = dto.Rows.Select(r => r.Select(Normalize).ToList()).ToList(),
            ElapsedMs = dto.ElapsedMs,
            InteropCopyMs = dto.InteropCopyMs
        };
    }

    private static object? Normalize(JsonElement element) => element.ValueKind switch
    {
        JsonValueKind.Null or JsonValueKind.Undefined => null,
        JsonValueKind.String => element.GetString(),
        JsonValueKind.Number when element.TryGetInt64(out var i) => i,
        JsonValueKind.Number => element.GetDouble(),
        JsonValueKind.True => true,
        JsonValueKind.False => false,
        _ => element.GetRawText()
    };

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    private sealed class BridgeStatus
    {
        [JsonPropertyName("ok")] public bool Ok { get; set; }
        [JsonPropertyName("message")] public string? Message { get; set; }
    }

    private sealed class QueryPayloadJson
    {
        [JsonPropertyName("columns")] public List<string> Columns { get; set; } = [];
        [JsonPropertyName("rows")] public List<List<JsonElement>> Rows { get; set; } = [];
        [JsonPropertyName("elapsedMs")] public double ElapsedMs { get; set; }
        [JsonPropertyName("interopCopyMs")] public double InteropCopyMs { get; set; }
    }
}
