namespace SapAnalytics.Core.Query;

public sealed class QueryResult
{
    public required IReadOnlyList<QueryColumn> Columns { get; init; }
    public required IReadOnlyList<QueryRow> Rows { get; init; }
    public long ElapsedMs { get; init; }
    public string? SourceTier { get; init; }
}

public sealed class QueryColumn
{
    public required string Name { get; init; }
    public string? DataType { get; init; }
}

public sealed class QueryRow
{
    public required IReadOnlyList<object?> Values { get; init; }
}
