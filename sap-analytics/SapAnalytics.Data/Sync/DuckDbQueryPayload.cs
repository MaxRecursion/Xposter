using System.Text.Json.Serialization;

namespace SapAnalytics.Data.Sync;

public sealed class DuckDbQueryPayload
{
    [JsonPropertyName("columns")]
    public required IReadOnlyList<string> Columns { get; init; }

    [JsonPropertyName("rows")]
    public required IReadOnlyList<IReadOnlyList<object?>> Rows { get; init; }

    [JsonPropertyName("elapsedMs")]
    public long ElapsedMs { get; init; }
}
