using SapAnalytics.Core.Cache;
using SapAnalytics.Core.Plugins;

namespace SapAnalytics.Client.Services;

public sealed class WidgetRegistry
{
    private readonly List<IReportWidget> _widgets = new()
    {
        new KpiWidget(),
        new ChartWidget(),
        new TableWidget()
    };

    public IReadOnlyList<WidgetDescriptor> GetDescriptors() =>
        _widgets.Select(w => new WidgetDescriptor
        {
            WidgetType = w.WidgetType,
            DisplayName = w.DisplayName
        }).ToList();

    public IReportWidget? Resolve(ViewWidgetContext context) =>
        _widgets.FirstOrDefault(w => w.CanRender(context));
}

internal sealed class KpiWidget : IReportWidget
{
    public string WidgetType => "kpi";
    public string DisplayName => "KPI Card";
    public bool CanRender(ViewWidgetContext context) => context.Tier1Kind == Tier1EntryKind.Kpi;
}

internal sealed class ChartWidget : IReportWidget
{
    public string WidgetType => "chart";
    public string DisplayName => "Chart";
    public bool CanRender(ViewWidgetContext context) => context.Tier1Kind == Tier1EntryKind.Chart;
}

internal sealed class TableWidget : IReportWidget
{
    public string WidgetType => "table";
    public string DisplayName => "Data Table";
    public bool CanRender(ViewWidgetContext context) =>
        context.Tier1Kind == Tier1EntryKind.Table || context.ColumnCount > 0;
}
