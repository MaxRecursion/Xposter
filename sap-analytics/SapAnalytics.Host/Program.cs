var builder = WebApplication.CreateBuilder(args);
builder.WebHost.UseStaticWebAssets();
var app = builder.Build();

app.UseBlazorFrameworkFiles();
app.UseStaticFiles();
app.MapFallbackToFile("index.html");

app.Run();
