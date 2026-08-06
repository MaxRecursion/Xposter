using SapAnalytics.Core.Benchmark;
using SapAnalytics.Data.Sync;

namespace SapAnalytics.Client.Services;

public sealed class BenchmarkService
{
    private readonly IDuckDbBridge _duckDb;
    private readonly IOpfsStorage _opfs;

    public BenchmarkService(IDuckDbBridge duckDb, IOpfsStorage opfs)
    {
        _duckDb = duckDb;
        _opfs = opfs;
    }

    public async Task<BenchmarkSuiteResult> RunSuiteAsync(CancellationToken cancellationToken = default)
    {
        var queries = new (string Name, string Sql)[]
        {
            ("count_transactions", "SELECT COUNT(*) FROM transactions"),
            ("sum_amount", "SELECT SUM(amount) FROM transactions"),
            ("group_by_period", "SELECT period, SUM(amount) FROM transactions GROUP BY period ORDER BY period"),
            ("join_company_totals", """
                SELECT c.name, SUM(t.amount)
                FROM transactions t
                JOIN companies c ON t.company_id = c.company_id
                GROUP BY c.name
                ORDER BY SUM(t.amount) DESC
                LIMIT 20
                """),
            ("filter_region", """
                SELECT COUNT(*)
                FROM transactions t
                JOIN companies c ON t.company_id = c.company_id
                WHERE c.region = 'North'
                """),
            ("fund_breakdown", """
                SELECT f.category, SUM(t.amount)
                FROM transactions t
                JOIN funds f ON t.fund_id = f.fund_id
                GROUP BY f.category
                """),
            ("avg_by_company", """
                SELECT c.name, AVG(t.amount)
                FROM transactions t
                JOIN companies c ON t.company_id = c.company_id
                GROUP BY c.name
                LIMIT 50
                """),
            ("date_range", """
                SELECT COUNT(*)
                FROM transactions
                WHERE transaction_date >= DATE '2024-06-01'
                """),
            ("top_users_region", """
                SELECT u.region, COUNT(*)
                FROM users u
                GROUP BY u.region
                """),
            ("complex_report", """
                SELECT c.region, f.category, t.period, SUM(t.amount), COUNT(*)
                FROM transactions t
                JOIN companies c ON t.company_id = c.company_id
                JOIN funds f ON t.fund_id = f.fund_id
                GROUP BY c.region, f.category, t.period
                ORDER BY t.period, c.region
                LIMIT 100
                """)
        };

        var results = new List<BenchmarkQueryResult>();
        foreach (var (name, sql) in queries)
        {
            results.Add(await BenchmarkQueryAsync(name, sql, 5, cancellationToken));
        }

        var estimate = await _opfs.GetEstimateAsync(cancellationToken);
        var heap = await _duckDb.GetJsHeapUsedAsync(cancellationToken);

        return new BenchmarkSuiteResult
        {
            RunAt = DateTime.UtcNow,
            Queries = results,
            Memory = new BenchmarkMemorySnapshot
            {
                JsHeapUsedBytes = heap,
                OpfsUsageBytes = estimate?.UsageBytes,
                OpfsQuotaBytes = estimate?.QuotaBytes
            }
        };
    }

    private async Task<BenchmarkQueryResult> BenchmarkQueryAsync(
        string name,
        string sql,
        int iterations,
        CancellationToken cancellationToken)
    {
        var timings = new List<long>();
        long rowCount = 0;

        for (var i = 0; i < iterations; i++)
        {
            var payload = await _duckDb.QueryAsync(sql, cancellationToken);
            timings.Add(payload.ElapsedMs);
            rowCount = payload.Rows.Count;
        }

        timings.Sort();
        var p50 = timings[timings.Count / 2];
        var p95 = timings[(int)Math.Min(timings.Count - 1, Math.Ceiling(timings.Count * 0.95) - 1)];

        return new BenchmarkQueryResult
        {
            Name = name,
            Sql = sql,
            Iterations = iterations,
            MinMs = timings.First(),
            MaxMs = timings.Last(),
            P50Ms = p50,
            P95Ms = p95,
            RowCount = rowCount
        };
    }
}
