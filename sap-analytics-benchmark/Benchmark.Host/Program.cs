var builder = WebApplication.CreateBuilder(args);
builder.WebHost.UseStaticWebAssets();
var app = builder.Build();

app.Use(async (context, next) =>
{
    context.Response.Headers["Cross-Origin-Opener-Policy"] = "same-origin";
    context.Response.Headers["Cross-Origin-Embedder-Policy"] = "credentialless";
    context.Response.Headers["Cross-Origin-Resource-Policy"] = "cross-origin";
    await next();
});

app.UseBlazorFrameworkFiles();
app.UseStaticFiles();
app.MapFallbackToFile("index.html");

app.Run();
