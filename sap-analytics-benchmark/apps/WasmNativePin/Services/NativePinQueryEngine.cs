using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Serialization;
using Benchmark.Core;
using Benchmark.Core.Data;
using Benchmark.Core.Query;
using Benchmark.Core.Timing;
using WasmNativePin.Native;

namespace WasmNativePin.Services;

/// <summary>
/// V2 — DuckDB C/C++ compiled with .NET's Emscripten 3.1.56 and invoked via P/Invoke (no duckdb-wasm fallback).
/// </summary>
public sealed class NativePinQueryEngine : IQueryEngine
{
    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNameCaseInsensitive = true };

    private readonly HttpClient _http;
    private bool _dataLoaded;

    public NativePinQueryEngine(HttpClient http) => _http = http;

    public ApproachKind Approach => ApproachKind.WasmNativePin;
    public bool IsReady { get; private set; }
    public string StatusMessage { get; private set; } = "Native DuckDB not initialized.";
    public string LinkDiagnostic { get; private set; } = string.Empty;

    public async Task InitializeAsync(CancellationToken cancellationToken = default)
    {
        LinkDiagnostic = DuckDbNative.TryResolveSymbols();
        if (!LinkDiagnostic.StartsWith("OK", StringComparison.Ordinal))
        {
            IsReady = false;
            StatusMessage = $"Native DuckDB link failed: {LinkDiagnostic}";
            throw new InvalidOperationException(StatusMessage);
        }

        if (!_dataLoaded)
        {
            foreach (var file in SchemaDefinitions.DimensionFiles.Concat(SchemaDefinitions.FactFiles))
            {
                cancellationToken.ThrowIfCancellationRequested();
                var table = SchemaDefinitions.FileToTable[file];
                var bytes = await _http.GetByteArrayAsync($"data/{file}", cancellationToken);
                DuckDbNative.LoadCsv(table, bytes);
            }

            _dataLoaded = true;
        }

        IsReady = true;
        StatusMessage = "Native DuckDB ready (Emscripten 3.1.56, P/Invoke, in-memory + MEMFS CSV).";
    }

    public Task<BenchmarkRunResult> RunFullSuiteAsync(CancellationToken cancellationToken = default)
        => throw new NotSupportedException("Use BenchmarkSuite on the assessment page.");

    public Task<QueryResultSet> ExecuteBenchmarkQueryAsync(BenchmarkStepKind queryStep, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var sql = BenchmarkQueries.GetSql(queryStep);
        return Task.FromResult(Query(sql));
    }

    public QueryResultSet Query(string sql)
    {
        var sw = Stopwatch.StartNew();
        var json = DuckDbNative.QueryJson(sql);
        sw.Stop();

        var dto = JsonSerializer.Deserialize<QueryPayloadJson>(json, JsonOptions)
            ?? throw new InvalidOperationException("Empty native query payload.");

        return new QueryResultSet
        {
            Columns = dto.Columns,
            Rows = dto.Rows.Select(r => r.Select(Normalize).ToList()).ToList(),
            ElapsedMs = sw.Elapsed.TotalMilliseconds,
            InteropCopyMs = 0
        };
    }

    public ValueTask DisposeAsync()
    {
        try
        {
            DuckDbNative.Close();
        }
        catch
        {
            // ignore dispose failures
        }

        IsReady = false;
        _dataLoaded = false;
        return ValueTask.CompletedTask;
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

    private sealed class QueryPayloadJson
    {
        [JsonPropertyName("columns")] public List<string> Columns { get; set; } = [];
        [JsonPropertyName("rows")] public List<List<JsonElement>> Rows { get; set; } = [];
        [JsonPropertyName("elapsedMs")] public double ElapsedMs { get; set; }
        [JsonPropertyName("interopCopyMs")] public double InteropCopyMs { get; set; }
    }
}
