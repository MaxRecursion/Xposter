using Benchmark.Core;
using Benchmark.Core.Data;
using Benchmark.Core.Query;
using Benchmark.Core.Timing;
using Xunit;

namespace Benchmark.Tests;

public class TimingAggregatorTests
{
    [Fact]
    public void TotalMs_sums_all_steps()
    {
        var agg = new TimingAggregator();
        agg.AddManual(BenchmarkStepKind.Init, 10);
        agg.AddManual(BenchmarkStepKind.Q1ScanAgg, 400);
        var result = agg.Build(ApproachKind.WasmJsInterop, DateTimeOffset.UtcNow);

        Assert.Equal(410, result.TotalMs);
        Assert.Equal(400, result.QueryMs);
    }

    [Fact]
    public async Task MeasureAsync_records_elapsed()
    {
        var agg = new TimingAggregator();
        await agg.MeasureAsync(BenchmarkStepKind.LoadData, async () =>
        {
            await Task.Delay(5);
        });

        Assert.Single(agg.Steps);
        Assert.True(agg.Steps[0].ElapsedMs >= 0);
    }
}

public class BenchmarkQueriesTests
{
    [Theory]
    [InlineData(BenchmarkStepKind.Q1ScanAgg)]
    [InlineData(BenchmarkStepKind.Q2TimeSeries)]
    [InlineData(BenchmarkStepKind.Q3JoinFilter)]
    [InlineData(BenchmarkStepKind.Q4ForkJoin)]
    public void GetSql_returns_non_empty(BenchmarkStepKind step)
    {
        var sql = BenchmarkQueries.GetSql(step);
        Assert.False(string.IsNullOrWhiteSpace(sql));
        Assert.Contains("SELECT", sql, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void Q3_includes_join_and_filter()
    {
        var sql = BenchmarkQueries.Q3JoinFilter;
        Assert.Contains("JOIN companies", sql, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("WHERE", sql, StringComparison.OrdinalIgnoreCase);
    }
}

public class SyntheticDataGeneratorTests
{
    [Fact]
    public void GenerateTransactionsCsv_has_header_and_rows()
    {
        var csv = SyntheticDataGenerator.GenerateTransactionsCsv(100);
        var lines = csv.Split('\n', StringSplitOptions.RemoveEmptyEntries);
        Assert.Equal(101, lines.Length);
        Assert.StartsWith("transaction_id", lines[0]);
    }
}

public class BenchmarkSuiteSmokeTests
{
    [Fact]
    public async Task RunAsync_with_fake_engine_produces_steps()
    {
        var engine = new FakeQueryEngine();
        var suite = new BenchmarkSuite();
        var result = await suite.RunAsync(engine, _ => Task.CompletedTask, _ => Task.CompletedTask);

        Assert.Null(result.Error);
        Assert.True(result.Steps.Count >= 5);
        Assert.Equal(ApproachKind.WasmJsInterop, result.Approach);
    }

    private sealed class FakeQueryEngine : IQueryEngine
    {
        public ApproachKind Approach => ApproachKind.WasmJsInterop;
        public bool IsReady => true;
        public string StatusMessage => "fake";

        public Task InitializeAsync(CancellationToken cancellationToken = default) => Task.CompletedTask;

        public Task<BenchmarkRunResult> RunFullSuiteAsync(CancellationToken cancellationToken = default)
            => throw new NotImplementedException();

        public Task<QueryResultSet> ExecuteBenchmarkQueryAsync(BenchmarkStepKind queryStep, CancellationToken cancellationToken = default)
        {
            return Task.FromResult(new QueryResultSet
            {
                Columns = ["a"],
                Rows = [[1]],
                ElapsedMs = 10
            });
        }

        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }
}
