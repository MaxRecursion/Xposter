namespace Benchmark.Core.Data;

public static class SchemaDefinitions
{
    public const string CompaniesDdl = """
        CREATE TABLE companies (
            company_id INTEGER,
            name VARCHAR,
            region VARCHAR,
            group_id INTEGER
        )
        """;

    public const string FundsDdl = """
        CREATE TABLE funds (
            fund_id INTEGER,
            name VARCHAR,
            category VARCHAR
        )
        """;

    public const string UsersDdl = """
        CREATE TABLE users (
            user_id INTEGER,
            name VARCHAR,
            region VARCHAR,
            company_id INTEGER
        )
        """;

    public const string TransactionsDdl = """
        CREATE TABLE transactions (
            transaction_id BIGINT,
            company_id INTEGER,
            fund_id INTEGER,
            amount DECIMAL(19,4),
            period VARCHAR,
            transaction_date DATE
        )
        """;

    public const string FundsDistributionDdl = """
        CREATE TABLE funds_distribution (
            distribution_id BIGINT,
            fund_id INTEGER,
            company_id INTEGER,
            distribution_amount DECIMAL(19,4),
            period VARCHAR,
            distribution_date DATE
        )
        """;

    public static readonly IReadOnlyList<string> DimensionFiles =
    [
        "companies.csv",
        "funds.csv",
        "users.csv"
    ];

    public static readonly IReadOnlyList<string> FactFiles =
    [
        "transactions.csv",
        "funds_distribution.csv"
    ];

    public static readonly IReadOnlyDictionary<string, string> FileToTable = new Dictionary<string, string>
    {
        ["companies.csv"] = "companies",
        ["funds.csv"] = "funds",
        ["users.csv"] = "users",
        ["transactions.csv"] = "transactions",
        ["funds_distribution.csv"] = "funds_distribution"
    };
}
