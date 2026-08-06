using System.Text.Json.Serialization;

namespace SapAnalytics.Data.Sync;

public sealed class StorageEstimate
{
    [JsonPropertyName("usageBytes")]
    public long UsageBytes { get; init; }

    [JsonPropertyName("quotaBytes")]
    public long QuotaBytes { get; init; }
}
