using SapAnalytics.Core.Metadata;
using SapAnalytics.Core.Views;

namespace SapAnalytics.Query;

public sealed class SqlGenerationException : Exception
{
    public SqlGenerationException(string message) : base(message) { }
}

public sealed class SqlGenerator
{
    public string Generate(ViewDefinition view, EntityCatalog catalog, bool includeLimit = true)
    {
        var entity = catalog.Entities.FirstOrDefault(e => e.Id == view.BaseEntityId)
            ?? throw new SqlGenerationException($"Unknown base entity '{view.BaseEntityId}'.");

        var tableAliases = new Dictionary<string, string> { [entity.Id] = "base" };
        var selectParts = new List<string>();
        var usedAliases = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        foreach (var join in view.Joins)
        {
            var rel = catalog.Relationships.FirstOrDefault(r => r.Id == join.RelationshipId)
                ?? throw new SqlGenerationException($"Unknown relationship '{join.RelationshipId}'.");

            var fromEntity = catalog.Entities.First(e => e.Id == rel.FromEntityId);
            var toEntity = catalog.Entities.First(e => e.Id == rel.ToEntityId);

            if (!tableAliases.ContainsKey(fromEntity.Id))
                tableAliases[fromEntity.Id] = SanitizeAlias(fromEntity.Id);

            tableAliases[toEntity.Id] = SanitizeAlias(toEntity.Id);
        }

        foreach (var col in view.Columns.Where(c => c.Visible))
        {
            var (entityId, field) = ResolveField(col.FieldId, catalog);
            var alias = tableAliases[entityId];
            var output = $"{alias}.{QuoteIdentifier(field.ColumnName)}";
            var outAlias = col.Alias ?? field.ColumnName;
            if (!usedAliases.Add(outAlias))
                throw new SqlGenerationException($"Duplicate output alias '{outAlias}'.");
            selectParts.Add($"{output} AS {QuoteIdentifier(outAlias)}");
        }

        foreach (var grouping in view.Groupings)
        {
            var (entityId, field) = ResolveField(grouping.FieldId, catalog);
            var alias = tableAliases[entityId];
            var outAlias = field.ColumnName;
            if (!usedAliases.Contains(outAlias))
            {
                usedAliases.Add(outAlias);
                selectParts.Add($"{alias}.{QuoteIdentifier(field.ColumnName)} AS {QuoteIdentifier(outAlias)}");
            }
        }

        foreach (var agg in view.Aggregations)
        {
            var (entityId, field) = ResolveField(agg.FieldId, catalog);
            var alias = tableAliases[entityId];
            var fn = MapAggregate(agg.Function);
            var outAlias = agg.Alias ?? $"{fn}_{field.ColumnName}";
            if (!usedAliases.Add(outAlias))
                throw new SqlGenerationException($"Duplicate aggregate alias '{outAlias}'.");
            selectParts.Add($"{fn}({alias}.{QuoteIdentifier(field.ColumnName)}) AS {QuoteIdentifier(outAlias)}");
        }

        if (selectParts.Count == 0)
            selectParts.Add($"{tableAliases[entity.Id]}.*");

        var joinClause = BuildJoinClauses(view, catalog, tableAliases);
        var whereClause = BuildWhereClause(view, catalog, tableAliases);
        var groupClause = BuildGroupClause(view, catalog, tableAliases);
        var orderClause = BuildOrderClause(view, catalog, tableAliases);

        var fromTable = TableRef(entity.DuckTableName, tableAliases[entity.Id]);
        var sql = $"SELECT {string.Join(", ", selectParts)} FROM {fromTable} {joinClause}";
        if (!string.IsNullOrWhiteSpace(whereClause))
            sql += $" WHERE {whereClause}";
        if (!string.IsNullOrWhiteSpace(groupClause))
            sql += $" GROUP BY {groupClause}";
        if (!string.IsNullOrWhiteSpace(orderClause))
            sql += $" ORDER BY {orderClause}";
        if (includeLimit)
            sql += $" LIMIT {view.PreviewLimit}";

        return sql;
    }

    public string GenerateMaterializedViewSql(string viewName, ViewDefinition view, EntityCatalog catalog)
    {
        var baseSql = Generate(view, catalog, includeLimit: false);
        // Strip ORDER BY for view definitions — sort in grouped MV SQL can be invalid
        var noOrder = baseSql.Contains(" ORDER BY ", StringComparison.OrdinalIgnoreCase)
            ? baseSql[..baseSql.IndexOf(" ORDER BY ", StringComparison.OrdinalIgnoreCase)]
            : baseSql;
        return $"CREATE OR REPLACE VIEW {QuoteIdentifier(viewName)} AS {noOrder}";
    }

    private static string BuildJoinClauses(
        ViewDefinition view,
        EntityCatalog catalog,
        Dictionary<string, string> tableAliases)
    {
        var clauses = new List<string>();
        foreach (var join in view.Joins)
        {
            var rel = catalog.Relationships.First(r => r.Id == join.RelationshipId);
            var fromEntity = catalog.Entities.First(e => e.Id == rel.FromEntityId);
            var toEntity = catalog.Entities.First(e => e.Id == rel.ToEntityId);
            var fromAlias = tableAliases[fromEntity.Id];
            var toAlias = tableAliases[toEntity.Id];
            var keyword = rel.JoinType switch
            {
                JoinType.Inner => "INNER JOIN",
                JoinType.Left => "LEFT JOIN",
                JoinType.Right => "RIGHT JOIN",
                _ => "LEFT JOIN"
            };
            clauses.Add(
                $"{keyword} {TableRef(toEntity.DuckTableName, toAlias)} ON {fromAlias}.{QuoteIdentifier(rel.FromColumn)} = {toAlias}.{QuoteIdentifier(rel.ToColumn)}");
        }
        return string.Join(" ", clauses);
    }

    private static string BuildWhereClause(
        ViewDefinition view,
        EntityCatalog catalog,
        Dictionary<string, string> tableAliases)
    {
        var parts = new List<string>();
        foreach (var filter in view.Filters)
        {
            var (entityId, field) = ResolveField(filter.FieldId, catalog);
            if (!field.AllowFilter)
                throw new SqlGenerationException($"Field '{filter.FieldId}' is not filterable.");

            var alias = tableAliases[entityId];
            var col = $"{alias}.{QuoteIdentifier(field.ColumnName)}";
            parts.Add(BuildFilterExpression(col, field, filter));
        }
        return string.Join(" AND ", parts);
    }

    private static string BuildGroupClause(
        ViewDefinition view,
        EntityCatalog catalog,
        Dictionary<string, string> tableAliases)
    {
        if (view.Groupings.Count == 0 && view.Aggregations.Count > 0)
        {
            // implicit group by visible non-aggregate columns
            var cols = view.Columns
                .Where(c => c.Visible)
                .Select(c =>
                {
                    var (entityId, field) = ResolveField(c.FieldId, catalog);
                    return $"{tableAliases[entityId]}.{QuoteIdentifier(field.ColumnName)}";
                });
            return string.Join(", ", cols);
        }

        return string.Join(", ", view.Groupings.Select(g =>
        {
            var (entityId, field) = ResolveField(g.FieldId, catalog);
            return $"{tableAliases[entityId]}.{QuoteIdentifier(field.ColumnName)}";
        }));
    }

    private static string BuildOrderClause(
        ViewDefinition view,
        EntityCatalog catalog,
        Dictionary<string, string> tableAliases)
    {
        return string.Join(", ", view.Sort.Select(s =>
        {
            var (entityId, field) = ResolveField(s.FieldId, catalog);
            var dir = s.Descending ? "DESC" : "ASC";
            return $"{tableAliases[entityId]}.{QuoteIdentifier(field.ColumnName)} {dir}";
        }));
    }

    private static string BuildFilterExpression(string column, FieldDefinition field, ViewFilter filter)
    {
        var value = SqlParameterBinder.EscapeLiteral(filter.Value);
        switch (filter.Operator)
        {
            case FilterOperator.Equals:
                return $"{column} = {FormatLiteral(field, filter.Value)}";
            case FilterOperator.NotEquals:
                return $"{column} <> {FormatLiteral(field, filter.Value)}";
            case FilterOperator.GreaterThan:
                return $"{column} > {FormatLiteral(field, filter.Value)}";
            case FilterOperator.GreaterThanOrEqual:
                return $"{column} >= {FormatLiteral(field, filter.Value)}";
            case FilterOperator.LessThan:
                return $"{column} < {FormatLiteral(field, filter.Value)}";
            case FilterOperator.LessThanOrEqual:
                return $"{column} <= {FormatLiteral(field, filter.Value)}";
            case FilterOperator.In:
                var values = filter.Values ?? [];
                var formatted = values.Select(v => FormatLiteral(field, v));
                return $"{column} IN ({string.Join(", ", formatted)})";
            case FilterOperator.Contains:
                return $"{column} LIKE '%' || {FormatLiteral(field, filter.Value)} || '%'";
            case FilterOperator.StartsWith:
                return $"{column} LIKE {FormatLiteral(field, filter.Value)} || '%'";
            default:
                throw new SqlGenerationException($"Unsupported filter operator '{filter.Operator}'.");
        }
    }

    private static string FormatLiteral(FieldDefinition field, string? raw)
    {
        if (raw is null)
            throw new SqlGenerationException("Filter value is required.");

        return field.DataType switch
        {
            FieldDataType.String or FieldDataType.Date or FieldDataType.DateTime =>
                $"'{SqlParameterBinder.EscapeLiteral(raw)}'",
            FieldDataType.Boolean =>
                raw.Equals("true", StringComparison.OrdinalIgnoreCase) ? "TRUE" : "FALSE",
            _ => raw
        };
    }

    private static (string EntityId, FieldDefinition Field) ResolveField(string fieldId, EntityCatalog catalog)
    {
        foreach (var entity in catalog.Entities)
        {
            var field = entity.Fields.FirstOrDefault(f => f.Id == fieldId);
            if (field is not null)
                return (entity.Id, field);
        }
        throw new SqlGenerationException($"Unknown field '{fieldId}'.");
    }

    private static string MapAggregate(AggregateFunction fn) => fn switch
    {
        AggregateFunction.Count => "COUNT",
        AggregateFunction.Sum => "SUM",
        AggregateFunction.Average => "AVG",
        AggregateFunction.Min => "MIN",
        AggregateFunction.Max => "MAX",
        AggregateFunction.CountDistinct => "COUNT",
        _ => "COUNT"
    };

    private static string TableRef(string table, string alias) =>
        $"{QuoteIdentifier(table)} AS {QuoteIdentifier(alias)}";

    private static string SanitizeAlias(string entityId) =>
        entityId.Replace("-", "_", StringComparison.Ordinal);

    private static string QuoteIdentifier(string name) =>
        name.All(char.IsLetterOrDigit) ? name : $"\"{name.Replace("\"", "\"\"")}\"";
}
