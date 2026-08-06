using Benchmark.Core.Query;
using Benchmark.Core.Timing;

namespace Benchmark.Core;

public sealed class BenchmarkSuite
{
    private static readonly BenchmarkStepKind[] QuerySteps =
    [
        BenchmarkStepKind.Q1ScanAgg,
        BenchmarkStepKind.Q2TimeSeries,
        BenchmarkStepKind.Q3JoinFilter,
        BenchmarkStepKind.Q4ForkJoin
    ];

    public async Task<BenchmarkRunResult> RunAsync(
        IQueryEngine engine,
        Func<QueryResultSet, Task> bindGridAsync,
        Func<QueryResultSet, Task> bindChartAsync,
        CancellationToken cancellationToken = default)
    {
        var startedAt = DateTimeOffset.UtcNow;
        var timing = new TimingAggregator();

        try
        {
            await timing.MeasureAsync(BenchmarkStepKind.Init, () => engine.InitializeAsync(cancellationToken));

            QueryResultSet? lastResult = null;
            foreach (var step in QuerySteps)
            {
                var result = await engine.ExecuteBenchmarkQueryAsync(step, cancellationToken);
                timing.AddManual(step, result.ElapsedMs);
                if (result.InteropCopyMs > 0)
                    timing.AddManual(BenchmarkStepKind.ArrowInteropCopy, result.InteropCopyMs, notes: step.ToString());
                lastResult = result;
            }

            if (lastResult is not null)
            {
                await timing.MeasureAsync(BenchmarkStepKind.GridBind, () => bindGridAsync(lastResult));
                var chartResult = await engine.ExecuteBenchmarkQueryAsync(BenchmarkStepKind.Q2TimeSeries, cancellationToken);
                await timing.MeasureAsync(BenchmarkStepKind.ChartBind, () => bindChartAsync(chartResult));
            }

            return timing.Build(engine.Approach, startedAt, BenchmarkQueries.TransactionRowTarget);
        }
        catch (Exception ex)
        {
            return timing.Build(engine.Approach, startedAt, error: ex.Message);
        }
    }

    public static IReadOnlyList<BenchmarkStepKind> StandardQuerySteps => QuerySteps;
}
