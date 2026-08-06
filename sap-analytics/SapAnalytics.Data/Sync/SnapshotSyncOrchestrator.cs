using SapAnalytics.Core.Cache;
using SapAnalytics.Core.Manifest;
using SapAnalytics.Core.Sync;

namespace SapAnalytics.Data.Sync;

public interface IOpfsStorage
{
    Task WriteTextAsync(string path, string content, CancellationToken cancellationToken = default);
    Task<string?> ReadTextAsync(string path, CancellationToken cancellationToken = default);
    Task WriteBytesAsync(string path, byte[] data, CancellationToken cancellationToken = default);
    Task<byte[]?> ReadBytesAsync(string path, CancellationToken cancellationToken = default);
    Task DeleteAsync(string path, CancellationToken cancellationToken = default);
    Task DeleteDirectoryAsync(string path, CancellationToken cancellationToken = default);
    Task<IReadOnlyList<string>> ListDirectoriesAsync(string path, CancellationToken cancellationToken = default);
    Task<StorageEstimate?> GetEstimateAsync(CancellationToken cancellationToken = default);
}

public interface IDuckDbBridge
{
    Task InitializeAsync(CancellationToken cancellationToken = default);
    Task RegisterDatasetAsync(string entityId, string opfsPath, string format, CancellationToken cancellationToken = default);
    Task RefreshMaterializedViewsAsync(CancellationToken cancellationToken = default);
    Task<long> ExecuteScalarLongAsync(string sql, CancellationToken cancellationToken = default);
    Task<DuckDbQueryPayload> QueryAsync(string sql, CancellationToken cancellationToken = default);
    Task LoadSampleDataAsync(CancellationToken cancellationToken = default);
    Task<long?> GetJsHeapUsedAsync(CancellationToken cancellationToken = default);
}

public interface ISnapshotDownloadTransport
{
    Task<byte[]> DownloadAsync(string url, CancellationToken cancellationToken = default);
}

public sealed class SnapshotSyncOrchestrator
{
    private readonly IOpfsStorage _opfs;
    private readonly IDuckDbBridge _duckDb;
    private readonly ISnapshotDownloadTransport _transport;
    private readonly ActiveSnapshotPointerStore _pointerStore = new();
    private readonly SnapshotRetentionPlanner _retentionPlanner = new();

    public SnapshotSyncOrchestrator(
        IOpfsStorage opfs,
        IDuckDbBridge duckDb,
        ISnapshotDownloadTransport transport)
    {
        _opfs = opfs;
        _duckDb = duckDb;
        _transport = transport;
    }

    public async Task<SyncState> RunFullSyncAsync(
        SnapshotManifest manifest,
        Func<SyncProgress, Task>? onProgress = null,
        CancellationToken cancellationToken = default)
    {
        var stagingVersion = manifest.Version;
        var pointerJson = await _opfs.ReadTextAsync(SnapshotPathBuilder.ActivePointerFile, cancellationToken);
        var currentPointer = pointerJson is not null
            ? System.Text.Json.JsonSerializer.Deserialize<ActiveSnapshotPointer>(pointerJson)
            : null;

        var pointer = currentPointer is not null
            ? _pointerStore.BeginStaging(currentPointer, stagingVersion)
            : _pointerStore.CreateInitial(stagingVersion);

        try
        {
            await Report(onProgress, 0, manifest.Tables.Count);

            var filesCompleted = 0;
            foreach (var table in manifest.Tables)
            {
                var bytes = await _transport.DownloadAsync(table.DownloadUrl, cancellationToken);
                Manifest.ManifestValidator.VerifyTableFile(table, bytes);

                var stagingPath = SnapshotPathBuilder.StagingFilePath(stagingVersion, table.FileName);
                await _opfs.WriteBytesAsync(stagingPath, bytes, cancellationToken);

                filesCompleted++;
                await Report(onProgress, filesCompleted, manifest.Tables.Count, table.FileName);
            }

            foreach (var table in manifest.Tables)
            {
                var stagingPath = SnapshotPathBuilder.StagingFilePath(stagingVersion, table.FileName);
                var activePath = SnapshotPathBuilder.ActiveFilePath(stagingVersion, table.FileName);
                var data = await _opfs.ReadBytesAsync(stagingPath, cancellationToken)
                    ?? throw new InvalidOperationException($"Missing staged file {table.FileName}");
                await _opfs.WriteBytesAsync(activePath, data, cancellationToken);
            }

            await _duckDb.InitializeAsync(cancellationToken);
            foreach (var table in manifest.Tables)
            {
                var opfsPath = SnapshotPathBuilder.OpfsParquetPath(stagingVersion, table.FileName);
                await _duckDb.RegisterDatasetAsync(table.EntityId, opfsPath, table.Format, cancellationToken);
            }

            await _duckDb.RefreshMaterializedViewsAsync(cancellationToken);

            var tier1 = await Tier1CacheBuilder.BuildFromDuckDbAsync(_duckDb, manifest, cancellationToken);
            await _opfs.WriteTextAsync(SnapshotPathBuilder.Tier1CacheFile, Tier1CacheSerializer.Serialize(tier1), cancellationToken);

            var activated = _pointerStore.Activate(pointer, stagingVersion);
            await _opfs.WriteTextAsync(
                SnapshotPathBuilder.ActivePointerFile,
                System.Text.Json.JsonSerializer.Serialize(activated),
                cancellationToken);

            var dirs = await _opfs.ListDirectoriesAsync($"{SnapshotPathBuilder.Root}/active", cancellationToken);
            var toDelete = _retentionPlanner.PlanCleanup(stagingVersion, dirs);
            foreach (var version in toDelete)
            {
                await _opfs.DeleteDirectoryAsync(SnapshotPathBuilder.ActiveDirectory(version), cancellationToken);
                await _opfs.DeleteDirectoryAsync(SnapshotPathBuilder.StagingDirectory(version), cancellationToken);
                await _opfs.DeleteDirectoryAsync(SnapshotPathBuilder.RetainedDirectory(version), cancellationToken);
            }

            foreach (var table in manifest.Tables)
            {
                await _opfs.DeleteAsync(SnapshotPathBuilder.StagingFilePath(stagingVersion, table.FileName), cancellationToken);
            }

            return new SyncState
            {
                Phase = SyncPhase.Idle,
                ActiveVersion = stagingVersion,
                LastSuccessfulSync = DateTime.UtcNow,
                LastAttempt = DateTime.UtcNow
            };
        }
        catch (Exception ex)
        {
            return new SyncState
            {
                Phase = SyncPhase.Failed,
                ActiveVersion = pointer.ActiveVersion,
                StagingVersion = stagingVersion,
                LastAttempt = DateTime.UtcNow,
                ErrorMessage = ex.Message
            };
        }
    }

    private static async Task Report(
        Func<SyncProgress, Task>? onProgress,
        int completed,
        int total,
        string? currentFile = null)
    {
        if (onProgress is null) return;

        await onProgress(new SyncProgress
        {
            FilesCompleted = completed,
            FilesTotal = total,
            CurrentFile = currentFile
        });
    }
}
