using Benchmark.Core;
using Benchmark.Core.Query;
using Microsoft.AspNetCore.Components.Web;
using Microsoft.AspNetCore.Components.WebAssembly.Hosting;
using WasmNativePin;
using WasmNativePin.Services;

var builder = WebAssemblyHostBuilder.CreateDefault(args);
builder.RootComponents.Add<App>("#app");
builder.RootComponents.Add<HeadOutlet>("head::after");

builder.Services.AddScoped(sp => new HttpClient
{
    BaseAddress = new Uri(builder.HostEnvironment.BaseAddress),
    // 1M-row transactions.csv is ~41MB; browser default (~100s) is too tight under load.
    Timeout = TimeSpan.FromMinutes(10)
});
builder.Services.AddScoped<NativePinQueryEngine>();
builder.Services.AddScoped<IQueryEngine>(sp => sp.GetRequiredService<NativePinQueryEngine>());
builder.Services.AddScoped<BenchmarkSuite>();

await builder.Build().RunAsync();
