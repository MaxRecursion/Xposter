namespace SapAnalytics.Core.Manifest;

/// <summary>
/// SAP snapshot manifest contract — delivered with each full periodic export.
/// Coordinate schema changes with the SAP export team using manifest-schema.json.
/// </summary>
public sealed class SnapshotManifest
{
    public required string Version { get; init; }
    public required string SchemaVersion { get; init; }
    public required DateTime ExportedAt { get; init; }
    public bool BreakingSchemaChange { get; init; }
    public string? PreviousVersion { get; init; }
    public required IReadOnlyList<SnapshotTableFile> Tables { get; init; }
    public IReadOnlyList<string> SnapshotCacheSpecs { get; init; } = [];
}

public sealed class SnapshotTableFile
{
    public required string EntityId { get; init; }
    public required string FileName { get; init; }
    public required string DownloadUrl { get; init; }
    public long ByteSize { get; init; }
    public long RowCount { get; init; }
    public required string ChecksumSha256 { get; init; }
    public string? PartitionKey { get; init; }
    public string Format { get; init; } = "parquet";
    public string Compression { get; init; } = "zstd";
}

public sealed class ActiveSnapshotPointer
{
    public required string ActiveVersion { get; init; }
    public DateTime ActivatedAt { get; init; }
    public string? StagingVersion { get; init; }
    public SapAnalytics.Core.Sync.SyncPhase Phase { get; init; } = SapAnalytics.Core.Sync.SyncPhase.Idle;
}
