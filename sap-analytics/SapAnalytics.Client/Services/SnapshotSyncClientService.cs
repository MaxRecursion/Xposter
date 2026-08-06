using SapAnalytics.Core.Manifest;
using SapAnalytics.Core.Sync;
using SapAnalytics.Data.Manifest;
using SapAnalytics.Data.Sync;

namespace SapAnalytics.Client.Services;

public sealed class SnapshotSyncClientService
{
    private readonly SnapshotSyncOrchestrator _orchestrator;
    private readonly HttpClient _http;
    private SyncState _state = new();

    public SnapshotSyncClientService(
        IOpfsStorage opfs,
        IDuckDbBridge duckDb,
        HttpSnapshotDownloadTransport transport,
        HttpClient http)
    {
        _orchestrator = new SnapshotSyncOrchestrator(opfs, duckDb, transport);
        _http = http;
    }

    public SyncState CurrentState => _state;

    public event Action<SyncState>? StateChanged;

    public async Task InitializeSampleAsync(CancellationToken cancellationToken = default)
    {
        _state = await _orchestrator.RunFullSyncAsync(
            await LoadManifestAsync("sample-data/manifest-sample.json", cancellationToken),
            progress =>
            {
                UpdateState(new SyncState
                {
                    Phase = MapPhase(progress),
                    ActiveVersion = _state.ActiveVersion,
                    StagingVersion = _state.StagingVersion,
                    LastAttempt = DateTime.UtcNow,
                    Progress = progress
                });
                return Task.CompletedTask;
            },
            cancellationToken);
        StateChanged?.Invoke(_state);
    }

    public async Task SyncFromManifestUrlAsync(string manifestUrl, CancellationToken cancellationToken = default)
    {
        var manifest = await LoadManifestAsync(manifestUrl, cancellationToken);
        _state = await _orchestrator.RunFullSyncAsync(
            manifest,
            progress =>
            {
                UpdateState(new SyncState
                {
                    Phase = MapPhase(progress),
                    LastAttempt = DateTime.UtcNow,
                    Progress = progress
                });
                return Task.CompletedTask;
            },
            cancellationToken);
        StateChanged?.Invoke(_state);
    }

    private async Task<SnapshotManifest> LoadManifestAsync(string url, CancellationToken cancellationToken)
    {
        var json = await _http.GetStringAsync(url, cancellationToken);
        return ManifestParser.Parse(json);
    }

    private void UpdateState(SyncState state)
    {
        _state = state;
        StateChanged?.Invoke(_state);
    }

    private static SyncPhase MapPhase(SyncProgress progress) =>
        progress.FilesCompleted < progress.FilesTotal ? SyncPhase.Downloading : SyncPhase.Registering;
}
