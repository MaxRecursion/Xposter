using SapAnalytics.Core.Metadata;
using SapAnalytics.Core.Views;

namespace SapAnalytics.Query;

public static class MaterializedViewDefinitions
{
    public static IReadOnlyList<(string Name, ViewDefinition View)> BuildStandardViews()
    {
        return new[]
        {
            ("mv_company_transaction_summary", new ViewDefinition
            {
                Id = "mv_company_transaction_summary",
                DisplayName = "Company Transaction Summary",
                IsPredefined = true,
                BaseEntityId = "transactions",
                Joins = new[] { new ViewJoin { RelationshipId = "transaction_company" } },
                Columns = new[]
                {
                    new ViewColumn { FieldId = "company_name", Visible = true },
                    new ViewColumn { FieldId = "transaction_amount", Visible = false }
                },
                Aggregations = new[]
                {
                    new ViewAggregation { FieldId = "transaction_amount", Function = AggregateFunction.Sum, Alias = "total_amount" },
                    new ViewAggregation { FieldId = "transaction_id", Function = AggregateFunction.Count, Alias = "tx_count" }
                },
                Groupings = new[] { new ViewGrouping { FieldId = "company_name" } },
                PreviewLimit = int.MaxValue
            }),
            ("mv_period_totals", new ViewDefinition
            {
                Id = "mv_period_totals",
                DisplayName = "Period Totals",
                IsPredefined = true,
                BaseEntityId = "transactions",
                Columns = new[]
                {
                    new ViewColumn { FieldId = "transaction_period", Visible = true },
                    new ViewColumn { FieldId = "transaction_amount", Visible = false }
                },
                Aggregations = new[]
                {
                    new ViewAggregation { FieldId = "transaction_amount", Function = AggregateFunction.Sum, Alias = "total_amount" },
                    new ViewAggregation { FieldId = "transaction_id", Function = AggregateFunction.Count, Alias = "tx_count" }
                },
                Groupings = new[] { new ViewGrouping { FieldId = "transaction_period" } },
                Sort = new[] { new ViewSort { FieldId = "transaction_period", Descending = false } },
                PreviewLimit = int.MaxValue
            })
        };
    }

    public static IReadOnlyList<string> BuildRefreshSql(EntityCatalog catalog)
    {
        var generator = new SqlGenerator();
        return BuildStandardViews()
            .Select(v => generator.GenerateMaterializedViewSql(v.Name, v.View, catalog))
            .ToList();
    }
}
