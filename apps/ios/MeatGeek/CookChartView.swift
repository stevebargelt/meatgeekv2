import Charts
import MeatGeekKit
import SwiftUI

/// The cook's temperatures over the whole cook: "Loading chart…", "Chart not
/// available", the API's problem with Retry, "No readings yet", or the
/// chart. Mirrors apps/web/src/cooks/cook-chart.tsx.
struct CookChartSection: View {
    let model: CookChartModel

    var body: some View {
        Section("Temperatures") {
            switch model.state {
            case .loading:
                Text(CookChartModel.loadingText)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier(AccessibilityID.chartLoading)
            case .notAvailable:
                Text(CookChartModel.notAvailableText)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier(AccessibilityID.chartNotAvailable)
            case .failed(let problem):
                ProblemText(problem: problem)
                    .accessibilityIdentifier(AccessibilityID.chartError)
                Button("Retry") { model.retry() }
                    .accessibilityIdentifier(AccessibilityID.chartRetry)
            case .loaded:
                if let series = model.series, !series.rows.isEmpty {
                    CookChartView(series: series, unit: model.unit)
                } else {
                    Text(CookChartModel.emptyText)
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier(AccessibilityID.chartEmpty)
                }
            }
        }
    }
}

/// Per channel a min–max band and an average line, broken where the channel
/// has no value, a legend, a time x-axis and a temperature y-axis in the
/// device's unit. Touching and holding the chart (`chartXSelection`) selects
/// the nearest time: a rule and a callout with each channel's value there,
/// which stay after the finger lifts. Mirrors apps/web/src/cooks/cook-chart-view.tsx.
struct CookChartView: View {
    let series: ChartSeries
    let unit: TemperatureUnit

    static let height: CGFloat = 300

    /// What `chartXSelection` reports while a finger is down.
    @State private var touched: Date?
    /// The last time touched: the selection, kept after the finger lifts.
    @State private var selected: Date?

    var body: some View {
        let points = PlotPoint.all(series)
        let selectedRow = selected.flatMap { series.row(nearest: $0) }
        Chart {
            AreaPlot(
                points,
                x: .value("Time", \.t),
                yStart: .value("Min", \.lo),
                yEnd: .value("Max", \.hi),
                series: .value("Run", \.run)
            )
            // Its own translucent colour, not `opacity`: a plot's opacity
            // also dimmed the average lines drawn over it.
            .foregroundStyle(\.band)

            LinePlot(
                points,
                x: .value("Time", \.t),
                y: .value("Temperature", \.avg),
                series: .value("Run", \.run)
            )
            .foregroundStyle(by: .value("Channel", \.label))
            .lineStyle(\.stroke)

            // A run of one point has no line: mark it.
            PointPlot(
                points.filter(\.isAlone),
                x: .value("Time", \.t),
                y: .value("Temperature", \.avg)
            )
            .foregroundStyle(by: .value("Channel", \.label))

            if let selectedRow {
                RuleMark(x: .value("Selected", selectedRow.t))
                    .foregroundStyle(Color.secondary)
                    .lineStyle(StrokeStyle(lineWidth: 1))
                    .annotation(
                        position: .top, spacing: 4,
                        overflowResolution: .init(x: .fit(to: .chart), y: .fit(to: .chart))
                    ) {
                        SelectionCallout(row: selectedRow, values: series.values(in: selectedRow, unit: unit))
                    }
            }
        }
        .chartForegroundStyleScale(
            domain: series.channels.map(\.label),
            range: series.channels.map(\.chartColor)
        )
        .chartYScale(domain: .automatic(includesZero: false))
        .chartYAxisLabel(LiveText.symbol(unit))
        .chartLegend(position: .bottom, spacing: 12)
        .chartXSelection(value: $touched)
        .onChange(of: touched) { _, time in
            if let time { selected = time }
        }
        .frame(height: Self.height)
        .padding(.vertical, 8)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Temperature chart")
        .accessibilityValue(series.summary(unit: unit))
        .accessibilityIdentifier(AccessibilityID.chart)
    }
}

/// One channel's value at one time, flattened for the vectorized plots.
private struct PlotPoint {
    let t: Date
    let channel: LiveChannel
    let label: String
    /// The channel's run this point is in: lines and bands never join runs.
    let run: String
    let avg: Double
    let lo: Double
    let hi: Double
    let isAlone: Bool
    var band: Color { channel.chartColor.opacity(0.15) }
    var stroke: StrokeStyle { StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round) }

    static func all(_ series: ChartSeries) -> [PlotPoint] {
        series.channels.flatMap { channel in
            series.segments(of: channel).flatMap { segment in
                segment.points.map { point in
                    PlotPoint(
                        t: point.t, channel: channel, label: channel.label, run: segment.id,
                        avg: point.value.avg, lo: point.value.lo, hi: point.value.hi,
                        isAlone: segment.points.count == 1
                    )
                }
            }
        }
    }
}

/// The selected time and each channel's value there.
private struct SelectionCallout: View {
    let row: ChartRow
    let values: [(channel: LiveChannel, text: String)]

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(row.t, format: .dateTime.hour().minute())
                .font(.caption.weight(.semibold))
            ForEach(values, id: \.channel) { value in
                HStack(spacing: 4) {
                    Circle()
                        .fill(value.channel.chartColor)
                        .frame(width: 8, height: 8)
                    Text("\(value.channel.label) \(value.text)")
                        .font(.caption)
                        .monospacedDigit()
                }
            }
        }
        .padding(6)
        // Solid, not a material: a chart annotation has no backdrop to blur.
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 6))
        .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color(.separator)))
    }
}

extension LiveChannel {
    /// A fixed colour per channel: the dataviz palette's categorical slots
    /// 1–5 (the web chart's), each with its dark-mode step. Checked with the
    /// palette validator: adjacent pairs clear the colour-blind separation
    /// target in both modes; in light mode Probe 2–4 sit below 3:1 on white,
    /// so the legend and the selection callout name every channel.
    var chartColor: Color {
        let (light, dark): (UInt32, UInt32) = switch self {
        case .grill: (0x2a78d6, 0x3987e5)
        case .probe1: (0xeb6834, 0xd95926)
        case .probe2: (0x1baf7a, 0x199e70)
        case .probe3: (0xeda100, 0xc98500)
        case .probe4: (0xe87ba4, 0xd55181)
        }
        return Color(UIColor { traits in
            UIColor(rgb: traits.userInterfaceStyle == .dark ? dark : light)
        })
    }
}

private extension UIColor {
    convenience init(rgb: UInt32) {
        self.init(
            red: CGFloat((rgb >> 16) & 0xff) / 255,
            green: CGFloat((rgb >> 8) & 0xff) / 255,
            blue: CGFloat(rgb & 0xff) / 255,
            alpha: 1
        )
    }
}
