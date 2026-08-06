using System.Diagnostics;

namespace Benchmark.Core.Timing;

public sealed class TimingAggregator
{
    private readonly List<BenchmarkStepResult> _steps = [];
    private readonly Stopwatch _watch = new();

    public IReadOnlyList<BenchmarkStepResult> Steps => _steps;

    public async Task<T> MeasureAsync<T>(BenchmarkStepKind step, Func<Task<T>> action, string? notes = null, bool theoretical = false)
    {
        _watch.Restart();
        try
        {
            return await action();
        }
        finally
        {
            _watch.Stop();
            _steps.Add(new BenchmarkStepResult
            {
                Step = step,
                ElapsedMs = _watch.Elapsed.TotalMilliseconds,
                Notes = notes,
                IsTheoretical = theoretical
            });
        }
    }

    public async Task MeasureAsync(BenchmarkStepKind step, Func<Task> action, string? notes = null, bool theoretical = false)
    {
        await MeasureAsync(step, async () =>
        {
            await action();
            return true;
        }, notes, theoretical);
    }

    public T Measure<T>(BenchmarkStepKind step, Func<T> action, string? notes = null, bool theoretical = false)
    {
        _watch.Restart();
        try
        {
            return action();
        }
        finally
        {
            _watch.Stop();
            _steps.Add(new BenchmarkStepResult
            {
                Step = step,
                ElapsedMs = _watch.Elapsed.TotalMilliseconds,
                Notes = notes,
                IsTheoretical = theoretical
            });
        }
    }

    public void AddManual(BenchmarkStepKind step, double elapsedMs, string? notes = null, bool theoretical = false)
    {
        _steps.Add(new BenchmarkStepResult
        {
            Step = step,
            ElapsedMs = elapsedMs,
            Notes = notes,
            IsTheoretical = theoretical
        });
    }

    public void MergeFrom(IEnumerable<BenchmarkStepResult> external) => _steps.AddRange(external);

    public BenchmarkRunResult Build(ApproachKind approach, DateTimeOffset startedAt, int rowCount = 0, string? error = null) =>
        new()
        {
            Approach = approach,
            StartedAt = startedAt,
            CompletedAt = DateTimeOffset.UtcNow,
            Steps = _steps.ToList(),
            RowCount = rowCount,
            Error = error
        };
}
