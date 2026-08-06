using SapAnalytics.Core.Manifest;

namespace SapAnalytics.Data.Sync;

public static class SnapshotPathBuilder
{
    public const string Root = "snapshots";
    public const string ActivePointerFile = "snapshots/active.json";
    public const string Tier1CacheFile = "snapshots/tier1-cache.json";

    public static string StagingDirectory(string version) => $"{Root}/staging/{version}";

    public static string ActiveDirectory(string version) => $"{Root}/active/{version}";

    public static string RetainedDirectory(string version) => $"{Root}/retained/{version}";

    public static string StagingFilePath(string version, string fileName) =>
        $"{StagingDirectory(version)}/{fileName}";

    public static string ActiveFilePath(string version, string fileName) =>
        $"{ActiveDirectory(version)}/{fileName}";

    public static string OpfsParquetPath(string version, string fileName) =>
        $"opfs://{ActiveFilePath(version, fileName)}";
}

public sealed class SnapshotRetentionPlanner
{
  public IReadOnlyList<string> PlanCleanup(string activeVersion, IReadOnlyList<string> knownVersions, int retainGenerations = 2)
    {
        var sorted = knownVersions
            .Where(v => !string.IsNullOrWhiteSpace(v))
            .Distinct()
            .OrderByDescending(v => v, StringComparer.Ordinal)
            .ToList();

        var toKeep = sorted.Take(retainGenerations).ToHashSet(StringComparer.Ordinal);
        toKeep.Add(activeVersion);

        return sorted.Where(v => !toKeep.Contains(v)).ToList();
    }
}

public sealed class ActiveSnapshotPointerStore
{
    public ActiveSnapshotPointer CreateInitial(string version) => new()
    {
        ActiveVersion = version,
        ActivatedAt = DateTime.UtcNow,
        Phase = SapAnalytics.Core.Sync.SyncPhase.Idle
    };

    public ActiveSnapshotPointer BeginStaging(ActiveSnapshotPointer current, string stagingVersion) => new()
    {
        ActiveVersion = current.ActiveVersion,
        ActivatedAt = current.ActivatedAt,
        StagingVersion = stagingVersion,
        Phase = SapAnalytics.Core.Sync.SyncPhase.Downloading
    };

    public ActiveSnapshotPointer Activate(ActiveSnapshotPointer current, string newActiveVersion) => new()
    {
        ActiveVersion = newActiveVersion,
        ActivatedAt = DateTime.UtcNow,
        StagingVersion = null,
        Phase = SapAnalytics.Core.Sync.SyncPhase.Idle
    };
}
