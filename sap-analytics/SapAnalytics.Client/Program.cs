using Microsoft.AspNetCore.Components.Web;
using Microsoft.AspNetCore.Components.WebAssembly.Hosting;
using SapAnalytics.Client;
using SapAnalytics.Client.Services;
using SapAnalytics.Data.Sync;

var builder = WebAssemblyHostBuilder.CreateDefault(args);
builder.RootComponents.Add<App>("#app");
builder.RootComponents.Add<HeadOutlet>("head::after");

builder.Services.AddScoped(sp => new HttpClient { BaseAddress = new Uri(builder.HostEnvironment.BaseAddress) });

builder.Services.AddScoped<IOpfsStorage, OpfsStorageService>();
builder.Services.AddScoped<IDuckDbBridge, DuckDbBridgeService>();
builder.Services.AddScoped<HttpSnapshotDownloadTransport>();
builder.Services.AddScoped<ISnapshotDownloadTransport>(sp => sp.GetRequiredService<HttpSnapshotDownloadTransport>());
builder.Services.AddScoped<EntityCatalogService>();
builder.Services.AddScoped<TieredQueryService>();
builder.Services.AddScoped<SnapshotSyncClientService>();
builder.Services.AddScoped<BenchmarkService>();
builder.Services.AddScoped<WidgetRegistry>();

await builder.Build().RunAsync();
