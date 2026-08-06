using Benchmark.Core.Timing;

namespace Benchmark.Core.Query;

public static class BenchmarkQueries
{
    public const int DisplayRowCap = 500;
    public const int TransactionRowTarget = 1_000_000;

    public static string GetSql(BenchmarkStepKind step) => step switch
    {
        BenchmarkStepKind.Q1ScanAgg => Q1ScanAggregate,
        BenchmarkStepKind.Q2TimeSeries => Q2TimeSeries,
        BenchmarkStepKind.Q3JoinFilter => Q3JoinFilter,
        BenchmarkStepKind.Q4ForkJoin => Q4ForkJoin,
        _ => throw new ArgumentOutOfRangeException(nameof(step), step, "Not a benchmark query step.")
    };

    /// <summary>Q1 — full scan aggregate over 1M transactions.</summary>
    public const string Q1ScanAggregate = """
        SELECT
            COUNT(*) AS txn_count,
            SUM(amount) AS total_amount,
            AVG(amount) AS avg_amount
        FROM transactions
        """;

    /// <summary>Q2 — monthly time series by fund category.</summary>
    public const string Q2TimeSeries = """
        SELECT
            t.period,
            f.category,
            COUNT(*) AS txn_count,
            SUM(t.amount) AS total_amount
        FROM transactions t
        JOIN funds f ON t.fund_id = f.fund_id
        GROUP BY t.period, f.category
        ORDER BY t.period, f.category
        """;

    /// <summary>Q3 — dimension join + regional filter (common report shape).</summary>
    public const string Q3JoinFilter = """
        SELECT
            c.region,
            c.group_id,
            COUNT(*) AS txn_count,
            SUM(t.amount) AS total_amount
        FROM transactions t
        JOIN companies c ON t.company_id = c.company_id
        WHERE c.region IN ('North', 'South', 'East', 'West')
        GROUP BY c.region, c.group_id
        ORDER BY total_amount DESC
        LIMIT 200
        """;

    /// <summary>Q4 — fork-and-post-join across transactions and fund distributions.</summary>
    public const string Q4ForkJoin = """
        WITH txn_leg AS (
            SELECT
                t.period,
                SUM(t.amount) AS txn_amount,
                COUNT(*) AS txn_count
            FROM transactions t
            GROUP BY t.period
        ),
        dist_leg AS (
            SELECT
                d.period,
                SUM(d.distribution_amount) AS dist_amount,
                COUNT(*) AS dist_count
            FROM funds_distribution d
            GROUP BY d.period
        )
        SELECT
            COALESCE(txn_leg.period, dist_leg.period) AS period,
            txn_leg.txn_amount,
            txn_leg.txn_count,
            dist_leg.dist_amount,
            dist_leg.dist_count
        FROM txn_leg
        FULL OUTER JOIN dist_leg ON txn_leg.period = dist_leg.period
        ORDER BY period
        """;

    public static string ChartSql => """
        SELECT period, SUM(amount) AS total_amount
        FROM transactions
        GROUP BY period
        ORDER BY period
        LIMIT 36
        """;
}
