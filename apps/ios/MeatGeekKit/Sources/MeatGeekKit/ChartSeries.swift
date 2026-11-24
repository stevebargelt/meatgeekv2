import Foundation
public import MeatGeekAPI

public typealias CookChart = Components.Schemas.CookChart

/// One channel at one time, in the display unit.
public struct ChannelValue: Equatable, Sendable {
    public let avg: Double
    public let lo: Double
    public let hi: Double

    public init(avg: Double, lo: Double, hi: Double) {
        self.avg = avg
        self.lo = lo
        self.hi = hi
    }
}

/// One x position: a server bucket (at its start) or a pushed reading (at its
/// timestamp). A channel with no value here is a gap in its line, not zero.
public struct ChartRow: Equatable, Sendable {
    public let t: Date
    public private(set) var values: [LiveChannel: ChannelValue]

    public init(t: Date, values: [LiveChannel: ChannelValue] = [:]) {
        self.t = t
        self.values = values
    }

    public subscript(channel: LiveChannel) -> ChannelValue? {
        get { values[channel] }
        set { values[channel] = newValue }
    }
}

/// What the cook chart draws: the server's buckets, then the readings pushed
/// since it loaded that fall after the last bucket. A port of
/// apps/web/src/cooks/chart-series.ts.
public struct ChartSeries: Equatable, Sendable {
    /// At most this many pushed readings are drawn after the server series;
    /// the newest are kept (`MAX_PUSHED_ROWS`).
    public static let maxPushedRows = 2000

    public let rows: [ChartRow]
    /// Channels with a value in at least one row, in `LiveChannel` order
    /// (`CHART_CHANNELS`: Grill, Probe 1–4).
    public let channels: [LiveChannel]

    public init(rows: [ChartRow], channels: [LiveChannel]) {
        self.rows = rows
        self.channels = channels
    }

    /// `buildChartSeries`. A bucket covers `[t, t + bucketSeconds)`, so a
    /// pushed reading earlier than the last bucket's end is already counted
    /// in the server series and is dropped. The kept ones become one row
    /// each (`avg = lo = hi`), oldest first, capped at `maxPushedRows`.
    /// Values arrive in °F and are converted as the live panel converts them.
    public init(chart: CookChart, pushed: [TemperatureMessage], unit: TemperatureUnit) {
        func shown(_ fahrenheit: Double) -> Double { LiveText.displayValue(fahrenheit, unit: unit) }

        var rows: [ChartRow] = chart.points.map { point in
            var row = ChartRow(t: point.t)
            for channel in LiveChannel.allCases {
                if let value = Self.value(of: channel, in: point) {
                    row[channel] = ChannelValue(avg: shown(value.avg), lo: shown(value.min), hi: shown(value.max))
                }
            }
            return row
        }

        let seriesEnd = chart.points.last.map { $0.t.addingTimeInterval(TimeInterval(chart.bucketSeconds.rawValue)) }
        let transcoder = APIDateTranscoder()
        // A timestamp that does not parse is dropped, as Date.parse's NaN is.
        let live = pushed
            .compactMap { message in (try? transcoder.decode(message.timestamp)).map { (message, $0) } }
            .filter { _, t in seriesEnd.map { t >= $0 } ?? true }
            .sorted { $0.1 < $1.1 }
            .suffix(Self.maxPushedRows)
        for (message, t) in live {
            var row = ChartRow(t: t)
            for channel in LiveChannel.allCases {
                if let value = Self.value(of: channel, in: message) {
                    let display = shown(value)
                    row[channel] = ChannelValue(avg: display, lo: display, hi: display)
                }
            }
            rows.append(row)
        }

        self.rows = rows
        channels = LiveChannel.allCases.filter { channel in rows.contains { $0[channel] != nil } }
    }

    static func value(of channel: LiveChannel, in point: Components.Schemas.CookChartPoint) -> Components.Schemas.CookChartChannel? {
        switch channel {
        case .grill: point.grill
        case .probe1: point.probe1
        case .probe2: point.probe2
        case .probe3: point.probe3
        case .probe4: point.probe4
        }
    }

    static func value(of channel: LiveChannel, in message: TemperatureMessage) -> Double? {
        switch channel {
        case .grill: message.grillTemp
        case .probe1: message.probe1Temp
        case .probe2: message.probe2Temp
        case .probe3: message.probe3Temp
        case .probe4: message.probe4Temp
        }
    }

    // MARK: Drawing

    /// One unbroken run of a channel's values.
    public struct Segment: Equatable, Sendable, Identifiable {
        /// "<channel>-<n>": unique in the series, so each run is its own line.
        public let id: String
        public let channel: LiveChannel
        public let points: [Point]
    }

    public struct Point: Equatable, Sendable {
        public let t: Date
        public let value: ChannelValue
    }

    /// `channel`'s values split at every row that has none, so a line breaks
    /// there instead of joining across the gap (recharts' `connectNulls`
    /// off). A run of one point has no line to draw: the view marks it.
    public func segments(of channel: LiveChannel) -> [Segment] {
        var segments: [Segment] = []
        var run: [Point] = []
        func close() {
            guard !run.isEmpty else { return }
            segments.append(Segment(id: "\(channel.rawValue)-\(segments.count)", channel: channel, points: run))
            run = []
        }
        for row in rows {
            if let value = row[channel] {
                run.append(Point(t: row.t, value: value))
            } else {
                close()
            }
        }
        close()
        return segments
    }

    /// The row nearest `date`, for the selection; nil when there are none.
    public func row(nearest date: Date) -> ChartRow? {
        rows.min { abs($0.t.timeIntervalSince(date)) < abs($1.t.timeIntervalSince(date)) }
    }

    /// Each channel's value in `row`, as the selection lists it: "230 °F",
    /// with the bucket's range when it has one ("230 °F (220–240)").
    public func values(in row: ChartRow, unit: TemperatureUnit) -> [(channel: LiveChannel, text: String)] {
        channels.compactMap { channel in
            guard let value = row[channel] else { return nil }
            var text = Self.temperature(value.avg, unit: unit)
            if value.lo != value.hi {
                text += " (\(CookText.number(value.lo))–\(CookText.number(value.hi)))"
            }
            return (channel, text)
        }
    }

    /// The chart in words, for VoiceOver: the channels drawn, how many points,
    /// and each channel's latest value ("Grill, Probe 1; 2 points; latest
    /// Grill 229.5 °F, Probe 1 135 °F").
    public func summary(unit: TemperatureUnit) -> String {
        let latest = channels.compactMap { channel in
            rows.last { $0[channel] != nil }?[channel].map { "\(channel.label) \(Self.temperature($0.avg, unit: unit))" }
        }
        let count = rows.count == 1 ? "1 point" : "\(rows.count) points"
        return "\(channels.map(\.label).joined(separator: ", ")); \(count); latest \(latest.joined(separator: ", "))"
    }

    static func temperature(_ value: Double, unit: TemperatureUnit) -> String {
        "\(CookText.number(value)) \(LiveText.symbol(unit))"
    }
}
