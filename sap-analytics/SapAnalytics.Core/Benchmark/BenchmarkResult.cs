namespace SapAnalytics.Core.Benchmark;

public sealed class BenchmarkSuiteResult
{
    public required DateTime RunAt { get; init; }
    public string? SnapshotVersion { get; init; }
    public required IReadOnlyList<BenchmarkQueryResult> Queries { get; init; }
    public BenchmarkMemorySnapshot? Memory { get; init; }
}

public sealed class BenchmarkQueryResult
{
    public required string Name { get; init; }
    public required string Sql { get; init; }
    public long P50Ms { get; init; }
    public long P95Ms { get; init; }
    public long MinMs { get; init; }
    public long MaxMs { get; init; }
    public int Iterations { get; init; }
    public long RowCount { get; init; }
}

public sealed class BenchmarkMemorySnapshot
{
    public long? JsHeapUsedBytes { get; init; }
    public long? OpfsUsageBytes { get; init; }
    public long? OpfsQuotaBytes { get; init; }
}
