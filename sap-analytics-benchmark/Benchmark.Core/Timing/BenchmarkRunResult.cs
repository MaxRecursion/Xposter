using System.Text.Json;
using System.Text.Json.Serialization;

namespace Benchmark.Core.Timing;

public sealed class BenchmarkRunResult
{
    public required ApproachKind Approach { get; init; }
    public required DateTimeOffset StartedAt { get; init; }
    public required DateTimeOffset CompletedAt { get; init; }
    public required IReadOnlyList<BenchmarkStepResult> Steps { get; init; }
    public string? Error { get; init; }
    public int RowCount { get; init; }

    [JsonIgnore]
    public double TotalMs => Steps.Sum(s => s.ElapsedMs);

    public double QueryMs => Steps
        .Where(s => s.Step is BenchmarkStepKind.Q1ScanAgg
            or BenchmarkStepKind.Q2TimeSeries
            or BenchmarkStepKind.Q3JoinFilter
            or BenchmarkStepKind.Q4ForkJoin)
        .Sum(s => s.ElapsedMs);

    public string ToExportJson() => JsonSerializer.Serialize(this, BenchmarkJson.Options);
}

public static class BenchmarkJson
{
    public static readonly JsonSerializerOptions Options = new()
    {
        WriteIndented = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase) }
    };
}
