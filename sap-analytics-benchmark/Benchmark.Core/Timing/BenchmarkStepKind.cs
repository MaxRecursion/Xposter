namespace Benchmark.Core.Timing;

public enum BenchmarkStepKind
{
    Init,
    LoadData,
    RegisterOpfs,
    Q1ScanAgg,
    Q2TimeSeries,
    Q3JoinFilter,
    Q4ForkJoin,
    ArrowInteropCopy,
    GridBind,
    ChartBind
}

public static class BenchmarkStepLabels
{
    private static readonly IReadOnlyDictionary<BenchmarkStepKind, string> Labels = new Dictionary<BenchmarkStepKind, string>
    {
        [BenchmarkStepKind.Init] = "Init",
        [BenchmarkStepKind.LoadData] = "Load Data",
        [BenchmarkStepKind.RegisterOpfs] = "Register OPFS",
        [BenchmarkStepKind.Q1ScanAgg] = "Q1 Scan Agg",
        [BenchmarkStepKind.Q2TimeSeries] = "Q2 Time Series",
        [BenchmarkStepKind.Q3JoinFilter] = "Q3 Join+Filter",
        [BenchmarkStepKind.Q4ForkJoin] = "Q4 Fork-Join",
        [BenchmarkStepKind.ArrowInteropCopy] = "Arrow/Interop Copy",
        [BenchmarkStepKind.GridBind] = "Grid Bind",
        [BenchmarkStepKind.ChartBind] = "Chart Bind"
    };

    public static string GetLabel(BenchmarkStepKind kind) =>
        Labels.TryGetValue(kind, out var label) ? label : kind.ToString();
}
