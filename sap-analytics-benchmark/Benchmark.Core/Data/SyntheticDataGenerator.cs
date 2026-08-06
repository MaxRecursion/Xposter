using System.Globalization;
using System.Text;

namespace Benchmark.Core.Data;

/// <summary>Generates small deterministic CSV slices for unit tests (not the full 1M demo dataset).</summary>
public static class SyntheticDataGenerator
{
    private static readonly string[] Regions = ["North", "South", "East", "West"];
    private static readonly string[] Categories = ["Equity", "Debt", "Mixed", "Alternatives"];

    public static string GenerateCompaniesCsv(int count)
    {
        var sb = new StringBuilder();
        sb.AppendLine("company_id,name,region,group_id");
        for (var i = 1; i <= count; i++)
        {
            sb.AppendLine(string.Join(',',
                i,
                $"Company {i}",
                Regions[i % Regions.Length],
                (i % 50) + 1));
        }
        return sb.ToString();
    }

    public static string GenerateFundsCsv(int count)
    {
        var sb = new StringBuilder();
        sb.AppendLine("fund_id,name,category");
        for (var i = 1; i <= count; i++)
        {
            sb.AppendLine(string.Join(',',
                i,
                $"Fund {i}",
                Categories[i % Categories.Length]));
        }
        return sb.ToString();
    }

    public static string GenerateTransactionsCsv(int count, int seed = 42)
    {
        var rng = new Random(seed);
        var sb = new StringBuilder();
        sb.AppendLine("transaction_id,company_id,fund_id,amount,period,transaction_date");
        for (var i = 1; i <= count; i++)
        {
            var year = 2022 + (i % 3);
            var month = (i % 12) + 1;
            var amount = Math.Round(rng.NextDouble() * 1000 + 1, 4);
            sb.AppendLine(string.Join(',',
                i,
                (i % 500) + 1,
                (i % 20) + 1,
                amount.ToString(CultureInfo.InvariantCulture),
                $"{year}-{month:D2}",
                $"{year}-{month:D2}-{(i % 28) + 1:D2}"));
        }
        return sb.ToString();
    }

    public static string GenerateFundsDistributionCsv(int count, int seed = 99)
    {
        var rng = new Random(seed);
        var sb = new StringBuilder();
        sb.AppendLine("distribution_id,fund_id,company_id,distribution_amount,period,distribution_date");
        for (var i = 1; i <= count; i++)
        {
            var year = 2022 + (i % 3);
            var month = (i % 12) + 1;
            var amount = Math.Round(rng.NextDouble() * 500 + 1, 4);
            sb.AppendLine(string.Join(',',
                i,
                (i % 20) + 1,
                (i % 500) + 1,
                amount.ToString(CultureInfo.InvariantCulture),
                $"{year}-{month:D2}",
                $"{year}-{month:D2}-{(i % 28) + 1:D2}"));
        }
        return sb.ToString();
    }
}
