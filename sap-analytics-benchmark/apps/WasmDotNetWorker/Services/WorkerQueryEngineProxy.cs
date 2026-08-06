using System.Text.Json;
using System.Text.Json.Serialization;
using Benchmark.Core;
using Benchmark.Core.Query;
using Benchmark.Core.Timing;
using Microsoft.JSInterop;

namespace WasmDotNetWorker.Services;

/// <summary>
/// V3: IQueryEngine proxy — C# on main thread talks to duckdb-wasm inside a dedicated Web Worker
/// via a thin JS gateway (evolution toward .NET 11 blazorwebworker / WebWorkerClient).
/// </summary>
public sealed class WorkerQueryEngineProxy : IQueryEngine, IAsyncDisposable
{
    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNameCaseInsensitive = true };
    private readonly IJSRuntime _js;
    private IJSObjectReference? _workerModule;
    private bool _disposed;

    public WorkerQueryEngineProxy(IJSRuntime js) => _js = js;

    public ApproachKind Approach => ApproachKind.WasmDotNetWorker;
    public bool IsReady { get; private set; }
    public string StatusMessage { get; private set; } = "Worker not started";

    public async Task InitializeAsync(CancellationToken cancellationToken = default)
    {
        _workerModule = await _js.InvokeAsync<IJSObjectReference>("import", cancellationToken, "./js/worker-gateway.js");
        var result = await _workerModule.InvokeAsync<BridgeStatus>("initialize", cancellationToken);
        IsReady = result.Ok;
        StatusMessage = result.Message ?? "Query worker ready (.NET gateway → worker → duckdb-wasm).";
    }

    public async Task<BenchmarkRunResult> RunFullSuiteAsync(CancellationToken cancellationToken = default)
    {
        await EnsureWorkerAsync(cancellationToken);
        var json = await _workerModule!.InvokeAsync<string>("runFullSuite", cancellationToken);
        return JsonSerializer.Deserialize<BenchmarkRunResult>(json, BenchmarkJson.Options)
            ?? throw new InvalidOperationException("Empty benchmark result.");
    }

    public async Task<QueryResultSet> ExecuteBenchmarkQueryAsync(BenchmarkStepKind queryStep, CancellationToken cancellationToken = default)
    {
        await EnsureWorkerAsync(cancellationToken);
        var sql = BenchmarkQueries.GetSql(queryStep);
        var json = await _workerModule!.InvokeAsync<string>("queryJson", cancellationToken, sql);
        var dto = JsonSerializer.Deserialize<QueryPayloadJson>(json, JsonOptions)
            ?? throw new InvalidOperationException("Empty query payload.");

        return new QueryResultSet
        {
            Columns = dto.Columns,
            Rows = dto.Rows.Select(r => r.Select(Normalize).ToList()).ToList(),
            ElapsedMs = dto.ElapsedMs,
            InteropCopyMs = dto.InteropCopyMs + dto.WorkerRoundTripMs
        };
    }

    private async Task EnsureWorkerAsync(CancellationToken cancellationToken)
    {
        if (_workerModule is null)
            await InitializeAsync(cancellationToken);
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

    public async ValueTask DisposeAsync()
    {
        if (_disposed) return;
        _disposed = true;
        if (_workerModule is not null)
        {
            try { await _workerModule.InvokeVoidAsync("dispose"); } catch { /* ignore */ }
            await _workerModule.DisposeAsync();
        }
    }

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
        [JsonPropertyName("workerRoundTripMs")] public double WorkerRoundTripMs { get; set; }
    }
}
