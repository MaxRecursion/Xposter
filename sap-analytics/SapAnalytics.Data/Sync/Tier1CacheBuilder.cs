using System.Text.Json;
using SapAnalytics.Core.Cache;
using SapAnalytics.Core.Manifest;

namespace SapAnalytics.Data.Sync;

public static class Tier1CacheBuilder
{
    public static async Task<Tier1SnapshotBundle> BuildFromDuckDbAsync(
        IDuckDbBridge duckDb,
        SnapshotManifest manifest,
        CancellationToken cancellationToken = default)
    {
        var entries = new Dictionary<string, Tier1SnapshotEntry>(StringComparer.Ordinal);

        // Executive KPIs
        var totalTransactions = await duckDb.ExecuteScalarLongAsync(
            "SELECT COUNT(*) FROM transactions", cancellationToken);
        var totalAmount = await duckDb.QueryAsync(
            "SELECT ROUND(SUM(amount), 2) AS total FROM transactions", cancellationToken);
        var companyCount = await duckDb.ExecuteScalarLongAsync(
            "SELECT COUNT(*) FROM companies", cancellationToken);

        entries["kpi_total_transactions"] = new Tier1SnapshotEntry
        {
            Key = "kpi_total_transactions",
            Kind = Tier1EntryKind.Kpi,
            Kpi = new SnapshotKpi
            {
                Label = "Total Transactions",
                Value = totalTransactions.ToString("N0")
            }
        };

        var amountValue = totalAmount.Rows.FirstOrDefault()?.FirstOrDefault()?.ToString() ?? "0";
        entries["kpi_total_amount"] = new Tier1SnapshotEntry
        {
            Key = "kpi_total_amount",
            Kind = Tier1EntryKind.Kpi,
            Kpi = new SnapshotKpi
            {
                Label = "Total Amount",
                Value = amountValue,
                Subtitle = "All companies"
            }
        };

        entries["kpi_company_count"] = new Tier1SnapshotEntry
        {
            Key = "kpi_company_count",
            Kind = Tier1EntryKind.Kpi,
            Kpi = new SnapshotKpi
            {
                Label = "Companies",
                Value = companyCount.ToString("N0")
            }
        };

        // Chart: monthly totals
        var monthly = await duckDb.QueryAsync(
            """
            SELECT period, ROUND(SUM(amount), 2) AS total
            FROM transactions
            GROUP BY period
            ORDER BY period
            LIMIT 12
            """,
            cancellationToken);

        entries["chart_monthly_amount"] = new Tier1SnapshotEntry
        {
            Key = "chart_monthly_amount",
            Kind = Tier1EntryKind.Chart,
            Chart = new SnapshotChartSeries
            {
                Title = "Monthly Transaction Amount",
                Labels = monthly.Rows.Select(r => r[0]?.ToString() ?? "").ToList(),
                Series = new[]
                {
                    new ChartSeries
                    {
                        Name = "Amount",
                        Values = monthly.Rows.Select(r => Convert.ToDouble(r[1] ?? 0)).ToList()
                    }
                }
            }
        };

        // Top companies table
        var topCompanies = await duckDb.QueryAsync(
            """
            SELECT c.name, COUNT(*) AS tx_count, ROUND(SUM(t.amount), 2) AS total
            FROM transactions t
            JOIN companies c ON t.company_id = c.company_id
            GROUP BY c.name
            ORDER BY total DESC
            LIMIT 10
            """,
            cancellationToken);

        entries["table_top_companies"] = new Tier1SnapshotEntry
        {
            Key = "table_top_companies",
            Kind = Tier1EntryKind.Table,
            Table = new SnapshotTable
            {
                Headers = new[] { "Company", "Transactions", "Total Amount" },
                Rows = topCompanies.Rows
                    .Select(r => new[] { r[0]?.ToString() ?? "", r[1]?.ToString() ?? "", r[2]?.ToString() ?? "" })
                    .ToList()
            }
        };

        return new Tier1SnapshotBundle
        {
            SnapshotVersion = manifest.Version,
            GeneratedAt = DateTime.UtcNow,
            Entries = entries
        };
    }
}

public static class Tier1CacheSerializer
{
    private static readonly JsonSerializerOptions Options = new() { WriteIndented = true };

    public static string Serialize(Tier1SnapshotBundle bundle) =>
        JsonSerializer.Serialize(bundle, Options);

    public static Tier1SnapshotBundle? Deserialize(string json) =>
        JsonSerializer.Deserialize<Tier1SnapshotBundle>(json, Options);
}
