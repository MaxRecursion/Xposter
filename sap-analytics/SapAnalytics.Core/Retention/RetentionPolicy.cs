namespace SapAnalytics.Core.Retention;

/// <summary>
/// Hot/warm/cold tiering for scaling beyond client-local full snapshots.
/// </summary>
public sealed class RetentionPolicy
{
    public required string PolicyVersion { get; init; }
    public required IReadOnlyList<RetentionTier> Tiers { get; init; }
    public RetentionDefaults Defaults { get; init; } = new();
}

public sealed class RetentionTier
{
    public required RetentionTierKind Kind { get; init; }
    public required string Description { get; init; }
    public int? RetentionMonths { get; init; }
    public RetentionGranularity Granularity { get; init; }
    public bool SyncToClient { get; init; }
    public string? ServerEndpoint { get; init; }
    public IReadOnlyList<string> EntityIds { get; init; } = [];
}

public enum RetentionTierKind
{
    Hot,
    Warm,
    Cold
}

public enum RetentionGranularity
{
    FullDetail,
    DailyAggregate,
    MonthlyAggregate,
    OnDemand
}

public sealed class RetentionDefaults
{
    public int HotRetentionMonths { get; init; } = 24;
    public int WarmRetentionMonths { get; init; } = 60;
    public bool ColdRequiresServer { get; init; } = true;
}
