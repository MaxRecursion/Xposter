namespace Benchmark.Core.Timing;

public sealed class BenchmarkStepResult
{
    public required BenchmarkStepKind Step { get; init; }
    public required double ElapsedMs { get; init; }
    public string? Notes { get; init; }
    public bool IsTheoretical { get; init; }

    public string Label => BenchmarkStepLabels.GetLabel(Step);
}
