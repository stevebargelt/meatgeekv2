import Foundation
public import MeatGeekAPI

/// The target temperatures a cook can start with: the grill and four probes.
/// Mirrors `TARGET_KEYS` and `TARGET_LABELS` in apps/web/src/cooks/validation.ts.
public enum TargetKey: String, CaseIterable, Sendable, Hashable {
    case grill, probe1, probe2, probe3, probe4

    public var label: String {
        switch self {
        case .grill: "Grill target"
        case .probe1: "Probe 1 target"
        case .probe2: "Probe 2 target"
        case .probe3: "Probe 3 target"
        case .probe4: "Probe 4 target"
        }
    }

    /// This key's value in a cook's targets.
    public func value(in temps: Components.Schemas.TargetTemperatures?) -> Double? {
        guard let temps else { return nil }
        switch self {
        case .grill: return temps.grill
        case .probe1: return temps.probe1
        case .probe2: return temps.probe2
        case .probe3: return temps.probe3
        case .probe4: return temps.probe4
        }
    }
}

/// What the start form holds: every field as typed.
public struct StartCookInput: Equatable, Sendable {
    public var name: String
    public var meatType: String
    public var weight: String
    public var targets: [TargetKey: String]

    public init(name: String = "", meatType: String = "", weight: String = "", targets: [TargetKey: String] = [:]) {
        self.name = name
        self.meatType = meatType
        self.weight = weight
        self.targets = targets
    }

    public subscript(target key: TargetKey) -> String {
        get { targets[key] ?? "" }
        set { targets[key] = newValue }
    }
}

/// The start form's per-field messages; nil where the field is fine.
public struct StartCookFieldErrors: Equatable, Sendable {
    public var name: String?
    public var meatType: String?
    public var weight: String?
    public var targets: [TargetKey: String]

    public init(name: String? = nil, meatType: String? = nil, weight: String? = nil, targets: [TargetKey: String] = [:]) {
        self.name = name
        self.meatType = meatType
        self.weight = weight
        self.targets = targets
    }

    public var isEmpty: Bool { self == StartCookFieldErrors() }
}

/// Client-side checks that mirror the API's `StartCookRequest`
/// (libs/api-specs/spec/components/schemas/cook.yaml). The server stays
/// authoritative; these only save a round trip. Mirrors `validateStartCook`
/// and `toStartCookRequest` in apps/web/src/cooks/validation.ts, messages
/// included.
public enum CookValidation {
    public static let weightMessage = "Weight must be a number greater than 0 and at most 1000."

    public static func targetMessage(_ key: TargetKey) -> String {
        "\(key.label) must be a number from 0 to 1000."
    }

    /// A field's number: nil when blank, `.invalid` when it is not a finite
    /// number (JavaScript's `Number(trimmed)` and `isFinite`).
    enum Parsed: Equatable {
        case blank
        case invalid
        case number(Double)
    }

    static func parse(_ value: String) -> Parsed {
        let trimmed = DeviceValidation.trimmed(value)
        if trimmed.isEmpty { return .blank }
        guard let number = Double(trimmed), number.isFinite else { return .invalid }
        return .number(number)
    }

    public static func validate(_ input: StartCookInput) -> StartCookFieldErrors {
        var errors = StartCookFieldErrors(
            name: DeviceValidation.label("Name", input.name),
            meatType: DeviceValidation.label("Meat type", input.meatType)
        )
        switch parse(input.weight) {
        case .blank: break
        case .invalid: errors.weight = weightMessage
        case .number(let weight): if weight <= 0 || weight > 1000 { errors.weight = weightMessage }
        }
        errors.targets = validateTargets(input.targets)
        return errors
    }

    /// Each target's message, keyed by the targets that break the rule: a
    /// blank one is no target, anything else must be a number from 0 to
    /// 1000. The start form and a running cook's target editing share it.
    public static func validateTargets(_ targets: [TargetKey: String]) -> [TargetKey: String] {
        var errors: [TargetKey: String] = [:]
        for key in TargetKey.allCases {
            switch parse(targets[key] ?? "") {
            case .blank: break
            case .invalid: errors[key] = targetMessage(key)
            case .number(let target): if target < 0 || target > 1000 { errors[key] = targetMessage(key) }
            }
        }
        return errors
    }

    /// The targets typed, blank ones left out; empty when every one is blank.
    public static func targetTemps(_ targets: [TargetKey: String]) -> Components.Schemas.StartCookTargetTemperatures {
        var temps = Components.Schemas.StartCookTargetTemperatures()
        for key in TargetKey.allCases {
            guard case .number(let target) = parse(targets[key] ?? "") else { continue }
            switch key {
            case .grill: temps.grill = target
            case .probe1: temps.probe1 = target
            case .probe2: temps.probe2 = target
            case .probe3: temps.probe3 = target
            case .probe4: temps.probe4 = target
            }
        }
        return temps
    }

    /// The `POST /cooks` body for a valid input. `id` is the start intent's
    /// idempotency key; blank optional fields are left out.
    public static func request(id: String, deviceID: String, input: StartCookInput) -> Components.Schemas.StartCookRequest {
        var body = Components.Schemas.StartCookRequest(
            id: id,
            name: DeviceValidation.trimmed(input.name),
            deviceId: deviceID,
            meatType: DeviceValidation.trimmed(input.meatType)
        )
        if case .number(let weight) = parse(input.weight) { body.weight = weight }
        let temps = targetTemps(input.targets)
        if temps != Components.Schemas.StartCookTargetTemperatures() { body.targetTemps = temps }
        return body
    }
}

/// How cook fields read on screen. Mirrors apps/web/src/cooks/time.ts.
public enum CookText {
    /// A date and time in the user's locale and time zone (`toLocaleString`).
    public static func dateTime(_ date: Date, locale: Locale = .autoupdatingCurrent, timeZone: TimeZone = .autoupdatingCurrent) -> String {
        date.formatted(Date.FormatStyle(date: .abbreviated, time: .shortened, locale: locale, timeZone: timeZone))
    }

    /// A duration as `H:MM:SS`; hours grow past 24 rather than rolling into
    /// days, and a negative duration is 0:00:00 (`formatElapsed`).
    public static func elapsed(_ seconds: TimeInterval) -> String {
        let total = max(0, Int(seconds.rounded(.down)))
        let hours = total / 3600
        let minutes = (total % 3600) / 60
        let rest = total % 60
        return "\(hours):\(twoDigits(minutes)):\(twoDigits(rest))"
    }

    /// The status word, capitalized: "Active", "Completed".
    public static func status(_ status: Components.Schemas.CookStatus) -> String {
        status.rawValue.prefix(1).uppercased() + status.rawValue.dropFirst()
    }

    /// "<n> °F", without a trailing ".0".
    public static func temperature(_ value: Double) -> String {
        "\(number(value)) °F"
    }

    /// "<n> lb", without a trailing ".0".
    public static func weight(_ value: Double) -> String {
        "\(number(value)) lb"
    }

    /// A number as JavaScript prints it: 225, 4.25.
    static func number(_ value: Double) -> String {
        value == value.rounded() && abs(value) < 1e15 ? String(Int64(value)) : String(value)
    }

    private static func twoDigits(_ value: Int) -> String {
        value < 10 ? "0\(value)" : "\(value)"
    }
}
