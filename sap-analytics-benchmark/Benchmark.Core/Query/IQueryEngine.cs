using Benchmark.Core.Timing;

namespace Benchmark.Core.Query;

public sealed class QueryResultSet
{
    public required IReadOnlyList<string> Columns { get; init; }
    public required IReadOnlyList<IReadOnlyList<object?>> Rows { get; init; }
    public double ElapsedMs { get; init; }
    public double InteropCopyMs { get; init; }
    public int TotalRowCount => Rows.Count;
}

public interface IQueryEngine : IAsyncDisposable
{
    ApproachKind Approach { get; }
    bool IsReady { get; }
    string StatusMessage { get; }

    Task InitializeAsync(CancellationToken cancellationToken = default);
    Task<BenchmarkRunResult> RunFullSuiteAsync(CancellationToken cancellationToken = default);
    Task<QueryResultSet> ExecuteBenchmarkQueryAsync(BenchmarkStepKind queryStep, CancellationToken cancellationToken = default);
}
