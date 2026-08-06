using SapAnalytics.Core.Cache;

namespace SapAnalytics.Core.Plugins;

public interface IReportWidget
{
    string WidgetType { get; }
    string DisplayName { get; }
    bool CanRender(ViewWidgetContext context);
}

public sealed class ViewWidgetContext
{
    public required string ViewId { get; init; }
    public Tier1EntryKind? Tier1Kind { get; init; }
    public bool HasAggregations { get; init; }
    public int ColumnCount { get; init; }
}

public sealed class WidgetDescriptor
{
    public required string WidgetType { get; init; }
    public required string DisplayName { get; init; }
    public string? Icon { get; init; }
}
