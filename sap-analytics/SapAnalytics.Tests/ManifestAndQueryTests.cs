using System.Security.Cryptography;
using System.Text;
using SapAnalytics.Core.Manifest;
using SapAnalytics.Data.Manifest;
using SapAnalytics.Data.Sync;

namespace SapAnalytics.Tests;

public class ManifestParserTests
{
    [Fact]
    public void Parse_valid_manifest()
    {
        var json = """
        {
          "version": "v1",
          "schemaVersion": "1.0",
          "exportedAt": "2026-08-05T00:00:00Z",
          "tables": [
            {
              "entityId": "transactions",
              "fileName": "transactions.parquet",
              "downloadUrl": "https://sap.example/transactions.parquet",
              "byteSize": 100,
              "rowCount": 10,
              "checksumSha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
            }
          ]
        }
        """;

        var manifest = ManifestParser.Parse(json);
        Assert.Equal("v1", manifest.Version);
        Assert.Single(manifest.Tables);
    }

    [Fact]
    public void Verify_checksum_matches()
    {
        var data = Encoding.UTF8.GetBytes("hello");
        var hash = Convert.ToHexString(SHA256.HashData(data));
        Assert.True(ManifestValidator.VerifyChecksum(data, hash));
    }
}

public class SnapshotRetentionTests
{
    [Fact]
    public void Plan_cleanup_retains_active_and_previous()
    {
        var planner = new SnapshotRetentionPlanner();
        var toDelete = planner.PlanCleanup("v3", new[] { "v1", "v2", "v3" });
        Assert.Contains("v1", toDelete);
        Assert.DoesNotContain("v2", toDelete);
        Assert.DoesNotContain("v3", toDelete);
    }
}

public class SqlGeneratorTests
{
    [Fact]
    public void Generate_sql_with_filter_and_limit()
    {
        var catalog = new SapAnalytics.Core.Metadata.EntityCatalog
        {
            SchemaVersion = "1.0",
            Entities = new[]
            {
                new SapAnalytics.Core.Metadata.EntityDefinition
                {
                    Id = "transactions",
                    DisplayName = "Transactions",
                    DuckTableName = "transactions",
                    Fields = new[]
                    {
                        new SapAnalytics.Core.Metadata.FieldDefinition
                        {
                            Id = "transaction_amount",
                            ColumnName = "amount",
                            DisplayName = "Amount",
                            DataType = SapAnalytics.Core.Metadata.FieldDataType.Decimal,
                            AllowAggregate = true
                        },
                        new SapAnalytics.Core.Metadata.FieldDefinition
                        {
                            Id = "transaction_period",
                            ColumnName = "period",
                            DisplayName = "Period",
                            DataType = SapAnalytics.Core.Metadata.FieldDataType.String
                        }
                    }
                }
            },
            Relationships = []
        };

        var view = new SapAnalytics.Core.Views.ViewDefinition
        {
            Id = "test",
            DisplayName = "Test",
            BaseEntityId = "transactions",
            Columns = new[]
            {
                new SapAnalytics.Core.Views.ViewColumn { FieldId = "transaction_period", Visible = true },
                new SapAnalytics.Core.Views.ViewColumn { FieldId = "transaction_amount", Visible = true }
            },
            Filters = new[]
            {
                new SapAnalytics.Core.Views.ViewFilter
                {
                    FieldId = "transaction_period",
                    Operator = SapAnalytics.Core.Views.FilterOperator.Equals,
                    Value = "2024-01"
                }
            },
            PreviewLimit = 50
        };

        var sql = new SapAnalytics.Query.SqlGenerator().Generate(view, catalog);
        Assert.Contains("FROM transactions AS base", sql);
        Assert.Contains("period = '2024-01'", sql);
        Assert.Contains("LIMIT 50", sql);
    }

    [Fact]
    public void Materialized_view_sql_uses_table_aliases_not_table_as_alias()
    {
        var catalog = new SapAnalytics.Core.Metadata.EntityCatalog
        {
            SchemaVersion = "1.0",
            Entities = new[]
            {
                new SapAnalytics.Core.Metadata.EntityDefinition
                {
                    Id = "transactions",
                    DisplayName = "Transactions",
                    DuckTableName = "transactions",
                    Fields = new[]
                    {
                        new SapAnalytics.Core.Metadata.FieldDefinition
                        {
                            Id = "transaction_id",
                            ColumnName = "transaction_id",
                            DisplayName = "Transaction ID",
                            DataType = SapAnalytics.Core.Metadata.FieldDataType.Integer,
                            AllowAggregate = true
                        },
                        new SapAnalytics.Core.Metadata.FieldDefinition
                        {
                            Id = "transaction_amount",
                            ColumnName = "amount",
                            DisplayName = "Amount",
                            DataType = SapAnalytics.Core.Metadata.FieldDataType.Decimal,
                            AllowAggregate = true
                        },
                        new SapAnalytics.Core.Metadata.FieldDefinition
                        {
                            Id = "transaction_company_id",
                            ColumnName = "company_id",
                            DisplayName = "Company ID",
                            DataType = SapAnalytics.Core.Metadata.FieldDataType.Integer
                        }
                    }
                },
                new SapAnalytics.Core.Metadata.EntityDefinition
                {
                    Id = "companies",
                    DisplayName = "Companies",
                    DuckTableName = "companies",
                    Fields = new[]
                    {
                        new SapAnalytics.Core.Metadata.FieldDefinition
                        {
                            Id = "company_name",
                            ColumnName = "name",
                            DisplayName = "Company Name",
                            DataType = SapAnalytics.Core.Metadata.FieldDataType.String
                        },
                        new SapAnalytics.Core.Metadata.FieldDefinition
                        {
                            Id = "company_id",
                            ColumnName = "company_id",
                            DisplayName = "Company ID",
                            DataType = SapAnalytics.Core.Metadata.FieldDataType.Integer
                        }
                    }
                }
            },
            Relationships = new[]
            {
                new SapAnalytics.Core.Metadata.RelationshipDefinition
                {
                    Id = "transaction_company",
                    FromEntityId = "transactions",
                    FromColumn = "company_id",
                    ToEntityId = "companies",
                    ToColumn = "company_id",
                    JoinType = SapAnalytics.Core.Metadata.JoinType.Left
                }
            }
        };

        var (name, view) = SapAnalytics.Query.MaterializedViewDefinitions.BuildStandardViews().First();
        var sql = new SapAnalytics.Query.SqlGenerator().GenerateMaterializedViewSql(name, view, catalog);
        Assert.DoesNotContain("AS companies.name", sql);
        Assert.Contains("companies.name AS name", sql);
    }
}
