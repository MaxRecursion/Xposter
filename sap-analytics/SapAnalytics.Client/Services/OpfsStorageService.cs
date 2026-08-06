using Microsoft.JSInterop;
using SapAnalytics.Data.Sync;

namespace SapAnalytics.Client.Services;

public sealed class OpfsStorageService : IOpfsStorage
{
    private readonly IJSRuntime _js;

    public OpfsStorageService(IJSRuntime js) => _js = js;

    public async Task WriteTextAsync(string path, string content, CancellationToken cancellationToken = default)
    {
        await _js.InvokeVoidAsync("SapAnalyticsBridge.writeText", cancellationToken, path, content);
    }

    public async Task<string?> ReadTextAsync(string path, CancellationToken cancellationToken = default)
    {
        return await _js.InvokeAsync<string?>("SapAnalyticsBridge.readText", cancellationToken, path);
    }

    public async Task WriteBytesAsync(string path, byte[] data, CancellationToken cancellationToken = default)
    {
        await _js.InvokeVoidAsync("SapAnalyticsBridge.writeBytes", cancellationToken, path, data);
    }

    public async Task<byte[]?> ReadBytesAsync(string path, CancellationToken cancellationToken = default)
    {
        var data = await _js.InvokeAsync<int[]?>("SapAnalyticsBridge.readBytes", cancellationToken, path);
        return data is null ? null : data.Select(b => (byte)b).ToArray();
    }

    public async Task DeleteAsync(string path, CancellationToken cancellationToken = default)
    {
        await _js.InvokeVoidAsync("SapAnalyticsBridge.deletePath", cancellationToken, path);
    }

    public async Task DeleteDirectoryAsync(string path, CancellationToken cancellationToken = default)
    {
        await _js.InvokeVoidAsync("SapAnalyticsBridge.deleteDirectory", cancellationToken, path);
    }

    public async Task<IReadOnlyList<string>> ListDirectoriesAsync(string path, CancellationToken cancellationToken = default)
    {
        var list = await _js.InvokeAsync<string[]>("SapAnalyticsBridge.listDirectories", cancellationToken, path);
        return list;
    }

    public async Task<StorageEstimate?> GetEstimateAsync(CancellationToken cancellationToken = default)
    {
        return await _js.InvokeAsync<StorageEstimate?>("SapAnalyticsBridge.getStorageEstimate", cancellationToken);
    }
}
