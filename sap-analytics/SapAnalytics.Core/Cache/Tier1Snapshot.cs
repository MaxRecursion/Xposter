namespace SapAnalytics.Core.Cache;

/// <summary>
/// Tier 1 precomputed snapshot — instant bind without SQL on navigation.
/// </summary>
public sealed class Tier1SnapshotBundle
{
    public required string SnapshotVersion { get; init; }
    public required DateTime GeneratedAt { get; init; }
    public required IReadOnlyDictionary<string, Tier1SnapshotEntry> Entries { get; init; }
}

public sealed class Tier1SnapshotEntry
{
    public required string Key { get; init; }
    public Tier1EntryKind Kind { get; init; }
    public SnapshotKpi? Kpi { get; init; }
    public SnapshotChartSeries? Chart { get; init; }
    public SnapshotTable? Table { get; init; }
}

public enum Tier1EntryKind
{
    Kpi,
    Chart,
    Table
}

public sealed class SnapshotKpi
{
    public required string Label { get; init; }
    public required string Value { get; init; }
    public string? Subtitle { get; init; }
    public string? Trend { get; init; }
}

public sealed class SnapshotChartSeries
{
    public required string Title { get; init; }
    public required IReadOnlyList<string> Labels { get; init; }
    public required IReadOnlyList<ChartSeries> Series { get; init; }
}

public sealed class ChartSeries
{
    public required string Name { get; init; }
    public required IReadOnlyList<double> Values { get; init; }
}

public sealed class SnapshotTable
{
    public required IReadOnlyList<string> Headers { get; init; }
    public required IReadOnlyList<IReadOnlyList<string>> Rows { get; init; }
}
