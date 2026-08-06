using SapAnalytics.Data.Sync;

namespace SapAnalytics.Client.Services;

public sealed class HttpSnapshotDownloadTransport : ISnapshotDownloadTransport
{
    private readonly HttpClient _http;

    public HttpSnapshotDownloadTransport(HttpClient http) => _http = http;

    public async Task<byte[]> DownloadAsync(string url, CancellationToken cancellationToken = default)
    {
        if (url.StartsWith("local://", StringComparison.OrdinalIgnoreCase))
        {
            var path = url["local://".Length..];
            return await _http.GetByteArrayAsync(path, cancellationToken);
        }

        return await _http.GetByteArrayAsync(url, cancellationToken);
    }
}
