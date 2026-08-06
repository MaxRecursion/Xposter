namespace Benchmark.Core;

public enum ApproachKind
{
    WasmJsInterop = 1,
    WasmNativePin = 2,
    WasmDotNetWorker = 3
}

public static class ApproachMetadata
{
    public static string GetDisplayName(ApproachKind kind) => kind switch
    {
        ApproachKind.WasmJsInterop => "V1 — duckdb-wasm (JS Interop)",
        ApproachKind.WasmNativePin => "V2 — Native DuckDB P/Invoke (Emscripten 3.1.56)",
        ApproachKind.WasmDotNetWorker => "V3 — .NET Web Worker gateway",
        _ => kind.ToString()
    };

    public static string GetRecommendation(ApproachKind kind) => kind switch
    {
        ApproachKind.WasmJsInterop => "Recommended for production",
        ApproachKind.WasmNativePin => "Native DuckDB linked into Blazor WASM (matched Emscripten)",
        ApproachKind.WasmDotNetWorker => "Evolution path (.NET 11+)",
        _ => string.Empty
    };
}
