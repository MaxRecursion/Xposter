namespace SapAnalytics.Core.Sync;

public sealed class SyncState
{
    public SyncPhase Phase { get; init; } = SyncPhase.Idle;
    public string? ActiveVersion { get; init; }
    public string? StagingVersion { get; init; }
    public DateTime? LastSuccessfulSync { get; init; }
    public DateTime? LastAttempt { get; init; }
    public string? ErrorMessage { get; init; }
    public SyncProgress? Progress { get; init; }
}

public enum SyncPhase
{
    Idle,
    Downloading,
    Verifying,
    Registering,
    RefreshingViews,
    BuildingCache,
    Activating,
    Failed
}

public sealed class SyncProgress
{
    public int FilesCompleted { get; init; }
    public int FilesTotal { get; init; }
    public long BytesDownloaded { get; init; }
    public long BytesTotal { get; init; }
    public string? CurrentFile { get; init; }
}
