namespace SapAnalytics.Query;

public static class SqlParameterBinder
{
    public static string EscapeLiteral(string? value) =>
        value?.Replace("'", "''", StringComparison.Ordinal) ?? string.Empty;
}
