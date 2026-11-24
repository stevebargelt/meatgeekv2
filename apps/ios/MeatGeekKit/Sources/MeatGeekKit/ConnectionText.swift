import Foundation
public import MeatGeekAPI

/// What a device row says about its connection (HAR-143). Mirrors
/// apps/web/src/devices/connection.ts.
public enum ConnectionText {
    public static let connected = "Connected"
    public static let offline = "Offline"
    public static let neverHeard = "Offline · never heard from"
    public static let unknown = "Status unknown"

    /// The connection as `GET /devices` reported it, aged against `now`: the
    /// moment the list was read, not a ticking clock.
    ///
    /// - "Connected", plus " · last heard <age> ago" when the hub has heard
    ///   from the device;
    /// - "Offline · last heard <age> ago";
    /// - "Offline · never heard from";
    /// - "Status unknown": the twin could not be read, or no connection was sent.
    public static func text(_ connection: Components.Schemas.DeviceConnection?, now: Date) -> String {
        let heard = connection?.lastActivityAt
        switch connection?.state {
        case .connected:
            guard let heard else { return connected }
            return "\(connected) · \(lastHeard(heard, now: now))"
        case .disconnected:
            guard let heard else { return neverHeard }
            return "\(offline) · \(lastHeard(heard, now: now))"
        case .unknown, nil:
            return unknown
        }
    }

    /// "last heard 3 min 4 s ago".
    public static func lastHeard(_ at: Date, now: Date) -> String {
        "last heard \(DurationText.text(now.timeIntervalSince(at))) ago"
    }
}

/// Durations in the live panel's style. Mirrors `formatDuration` in
/// apps/web/src/live/format.ts.
public enum DurationText {
    /// "12 s", "1 min 40 s" or "2 h 5 min". Negative counts as zero.
    public static func text(_ interval: TimeInterval) -> String {
        // Whole milliseconds first: a Date is a Double, and an age of exactly
        // 12 s can come out as 11.9999999 s, which would floor to 11.
        let milliseconds = max(0, Int((interval * 1000).rounded()))
        let total = milliseconds / 1000
        if total < 60 { return "\(total) s" }
        let minutes = total / 60
        if minutes < 60 { return "\(minutes) min \(total % 60) s" }
        return "\(minutes / 60) h \(minutes % 60) min"
    }
}
