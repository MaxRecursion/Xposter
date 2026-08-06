namespace SapAnalytics.Core.Views;

public sealed class ViewDefinition
{
    public required string Id { get; init; }
    public required string DisplayName { get; init; }
    public string? Description { get; init; }
    public bool IsPredefined { get; init; }
    public string? Tier1CacheKey { get; init; }
    public string? MaterializedViewName { get; init; }
    public required string BaseEntityId { get; init; }
    public IReadOnlyList<ViewJoin> Joins { get; init; } = [];
    public IReadOnlyList<ViewColumn> Columns { get; init; } = [];
    public IReadOnlyList<ViewFilter> Filters { get; init; } = [];
    public IReadOnlyList<ViewGrouping> Groupings { get; init; } = [];
    public IReadOnlyList<ViewAggregation> Aggregations { get; init; } = [];
    public IReadOnlyList<ViewSort> Sort { get; init; } = [];
    public int PreviewLimit { get; init; } = 200;
}

public sealed class ViewJoin
{
    public required string RelationshipId { get; init; }
}

public sealed class ViewColumn
{
    public required string FieldId { get; init; }
    public string? Alias { get; init; }
    public bool Visible { get; init; } = true;
}

public sealed class ViewFilter
{
    public required string FieldId { get; init; }
    public FilterOperator Operator { get; init; }
    public string? Value { get; init; }
    public IReadOnlyList<string>? Values { get; init; }
}

public enum FilterOperator
{
    Equals,
    NotEquals,
    GreaterThan,
    GreaterThanOrEqual,
    LessThan,
    LessThanOrEqual,
    In,
    Between,
    Contains,
    StartsWith
}

public sealed class ViewGrouping
{
    public required string FieldId { get; init; }
}

public sealed class ViewAggregation
{
    public required string FieldId { get; init; }
    public AggregateFunction Function { get; init; }
    public string? Alias { get; init; }
}

public enum AggregateFunction
{
    Count,
    Sum,
    Average,
    Min,
    Max,
    CountDistinct
}

public sealed class ViewSort
{
    public required string FieldId { get; init; }
    public bool Descending { get; init; }
}
