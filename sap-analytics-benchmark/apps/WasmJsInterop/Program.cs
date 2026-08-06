using Benchmark.Core;
using Benchmark.Core.Query;
using Microsoft.AspNetCore.Components.Web;
using Microsoft.AspNetCore.Components.WebAssembly.Hosting;
using WasmJsInterop;
using WasmJsInterop.Services;

var builder = WebAssemblyHostBuilder.CreateDefault(args);
builder.RootComponents.Add<App>("#app");
builder.RootComponents.Add<HeadOutlet>("head::after");

builder.Services.AddScoped<JsInteropQueryEngine>();
builder.Services.AddScoped<IQueryEngine>(sp => sp.GetRequiredService<JsInteropQueryEngine>());
builder.Services.AddScoped<BenchmarkSuite>();

await builder.Build().RunAsync();
