namespace SapAnalytics.Core.Metadata;

public sealed class EntityCatalog
{
    public required string SchemaVersion { get; init; }
    public required IReadOnlyList<EntityDefinition> Entities { get; init; }
    public required IReadOnlyList<RelationshipDefinition> Relationships { get; init; }
}

public sealed class EntityDefinition
{
    public required string Id { get; init; }
    public required string DisplayName { get; init; }
    public required string DuckTableName { get; init; }
    public string? ParquetGlob { get; init; }
    public EntityKind Kind { get; init; } = EntityKind.Fact;
    public required IReadOnlyList<FieldDefinition> Fields { get; init; }
    public IReadOnlyList<string> PartitionKeys { get; init; } = [];
}

public enum EntityKind
{
    Dimension,
    Fact,
    Bridge
}

public sealed class FieldDefinition
{
    public required string Id { get; init; }
    public required string ColumnName { get; init; }
    public required string DisplayName { get; init; }
    public FieldDataType DataType { get; init; }
    public bool IsPrimaryKey { get; init; }
    public bool IsForeignKey { get; init; }
    public string? ForeignEntityId { get; init; }
    public string? ForeignColumn { get; init; }
    public bool AllowFilter { get; init; } = true;
    public bool AllowGroup { get; init; } = true;
    public bool AllowAggregate { get; init; }
}

public enum FieldDataType
{
    String,
    Integer,
    Decimal,
    Date,
    DateTime,
    Boolean
}

public sealed class RelationshipDefinition
{
    public required string Id { get; init; }
    public required string FromEntityId { get; init; }
    public required string FromColumn { get; init; }
    public required string ToEntityId { get; init; }
    public required string ToColumn { get; init; }
    public JoinType JoinType { get; init; } = JoinType.Left;
}

public enum JoinType
{
    Inner,
    Left,
    Right
}
