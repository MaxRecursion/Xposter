using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;
using SapAnalytics.Core.Metadata;
using SapAnalytics.Core.Retention;
using SapAnalytics.Core.Views;

namespace SapAnalytics.Client.Services;

public sealed class EntityCatalogService
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
        Converters = { new JsonStringEnumConverter() }
    };

    private readonly HttpClient _http;
    private EntityCatalog? _cached;

    public EntityCatalogService(HttpClient http) => _http = http;

    public async Task<EntityCatalog> GetCatalogAsync(CancellationToken cancellationToken = default)
    {
        if (_cached is not null) return _cached;
        _cached = await _http.GetFromJsonAsync<EntityCatalog>("schemas/entity-catalog.json", JsonOptions, cancellationToken)
            ?? throw new InvalidOperationException("Failed to load entity catalog.");
        return _cached;
    }

    public async Task<IReadOnlyList<ViewDefinition>> GetPredefinedViewsAsync(CancellationToken cancellationToken = default)
    {
        var index = await _http.GetFromJsonAsync<PredefinedViewIndex>("view-definitions/index.json", JsonOptions, cancellationToken)
            ?? new PredefinedViewIndex { Views = [] };

        var views = new List<ViewDefinition>();
        foreach (var id in index.Views)
        {
            var view = await _http.GetFromJsonAsync<ViewDefinition>($"view-definitions/{id}.json", JsonOptions, cancellationToken);
            if (view is not null) views.Add(view);
        }
        return views;
    }

    public async Task<RetentionPolicy> GetRetentionPolicyAsync(CancellationToken cancellationToken = default)
    {
        return await _http.GetFromJsonAsync<RetentionPolicy>("schemas/retention-policy.json", JsonOptions, cancellationToken)
            ?? new RetentionPolicy
            {
                PolicyVersion = "1.0",
                Tiers = []
            };
    }

    private sealed class PredefinedViewIndex
    {
        public List<string> Views { get; init; } = [];
    }
}
