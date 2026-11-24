import Foundation

/// Client-side checks that mirror the API's (`ClaimDeviceRequest` and
/// `UpdateDeviceRequest` in libs/api-specs/spec/components/schemas/device.yaml).
/// The server stays authoritative; these only save a round trip. Mirrors
/// apps/web/src/devices/validation.ts, messages included.
public enum DeviceValidation {
    public static let deviceIDMessage = "Device ID must be 1-128 characters: letters, digits, and . _ : -"
    public static let claimCodeRequired = "Claim code is required."
    public static let locationTooLong = "Location must be at most 200 characters."

    /// The spec's device id pattern, `^[A-Za-z0-9._:-]{1,128}$`.
    public static func deviceID(_ value: String) -> String? {
        let allowed = value.unicodeScalars.allSatisfy { scalar in
            switch scalar {
            case "A"..."Z", "a"..."z", "0"..."9", ".", "_", ":", "-": true
            default: false
            }
        }
        return allowed && (1...128).contains(value.unicodeScalars.count) ? nil : deviceIDMessage
    }

    /// For a name: 1-100 characters after trimming. `label` starts the
    /// message ("Name is required.").
    public static func label(_ label: String, _ value: String) -> String? {
        let length = trimmed(value).unicodeScalars.count
        if length == 0 { return "\(label) is required." }
        if length > 100 { return "\(label) must be at most 100 characters." }
        return nil
    }

    /// Optional; at most 200 characters after trimming.
    public static func location(_ value: String) -> String? {
        trimmed(value).unicodeScalars.count > 200 ? locationTooLong : nil
    }

    /// Only that a code was typed. What makes a code well formed (12
    /// Crockford base32 symbols, `O` read as `0`, ...) is the API's to say,
    /// in its 400.
    public static func claimCode(_ value: String) -> String? {
        ClaimCode.format(value).isEmpty ? claimCodeRequired : nil
    }

    /// Every field's problem, if any.
    public static func claim(_ input: ClaimInput) -> ClaimFieldErrors {
        ClaimFieldErrors(
            deviceID: deviceID(input.deviceID),
            claimCode: claimCode(input.claimCode),
            name: label("Name", input.name),
            location: location(input.location)
        )
    }

    /// Spaces and line ends around a value, as JavaScript's `trim()` removes.
    public static func trimmed(_ value: String) -> String {
        value.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

/// What the claim form sends, as typed.
public struct ClaimInput: Equatable, Sendable {
    public var deviceID: String
    public var claimCode: String
    public var name: String
    public var location: String

    public init(deviceID: String = "", claimCode: String = "", name: String = "", location: String = "") {
        self.deviceID = deviceID
        self.claimCode = claimCode
        self.name = name
        self.location = location
    }
}

/// The claim form's per-field messages; nil where the field is fine.
public struct ClaimFieldErrors: Equatable, Sendable {
    public var deviceID: String?
    public var claimCode: String?
    public var name: String?
    public var location: String?

    public init(deviceID: String? = nil, claimCode: String? = nil, name: String? = nil, location: String? = nil) {
        self.deviceID = deviceID
        self.claimCode = claimCode
        self.name = name
        self.location = location
    }

    public var isEmpty: Bool { self == ClaimFieldErrors() }
}

/// The claim code field as the user types.
public enum ClaimCode {
    /// Upper case, in groups of four joined by hyphens (`XXXX-XXXX-XXXX`),
    /// whatever spaces or hyphens were typed. Every other character is kept
    /// as typed, so the API, which normalizes the code, is the one that
    /// judges it. Mirrors `formatClaimCode` in apps/web/src/devices/validation.ts.
    public static func format(_ raw: String) -> String {
        format(raw, cursor: raw.count).value
    }

    /// `format(_:)`, and where the caret goes: `cursor` is where it was in
    /// `raw` (in characters); the result puts it after the same symbols in
    /// `value`, and after the hyphens between them.
    public static func format(_ raw: String, cursor: Int) -> (value: String, cursor: Int) {
        var value = ""
        var count = 0
        var before = 0
        for (index, character) in raw.enumerated() where !(character.isWhitespace || character == "-") {
            if count > 0 && count % 4 == 0 { value.append("-") }
            value.append(contentsOf: String(character).uppercased())
            count += 1
            if index < cursor { before += 1 }
        }
        return (value, before + max(0, (before - 1) / 4))
    }
}
