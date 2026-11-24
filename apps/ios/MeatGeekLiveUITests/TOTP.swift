import CryptoKit
import Foundation

/// RFC 6238 TOTP (HMAC-SHA1, 30 s, 6 digits): the code an authenticator app
/// shows for the acceptance user. A port of `totpCode`, `normalizeTotpSecret`
/// and `msLeftInTotpWindow` in apps/web-e2e/live/helpers.ts; the offline
/// tests (`LiveOfflineTests`) check it against the same vectors.
///
/// Nothing here prints or logs; a code is a secret for its 30 s window.
enum TOTP {
    static let period: TimeInterval = 30

    /// Authenticator apps show secrets in groups, lower case, sometimes padded.
    static func normalize(_ secret: String) -> String {
        var out = secret.filter { !$0.isWhitespace && $0 != "-" }
        while out.hasSuffix("=") { out.removeLast() }
        return out.uppercased()
    }

    /// The secret's bytes, or nil when it is not base32 (RFC 4648, A–Z 2–7).
    static func decode(_ secret: String) -> Data? {
        let alphabet = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")
        let chars = normalize(secret)
        guard !chars.isEmpty else { return nil }
        var bits = 0
        var buffer = 0
        var bytes = Data()
        for char in chars {
            guard let value = alphabet.firstIndex(of: char) else { return nil }
            buffer = (buffer << 5) | value
            bits += 5
            if bits >= 8 {
                bits -= 8
                bytes.append(UInt8((buffer >> bits) & 0xFF))
            }
        }
        return bytes
    }

    /// The `digits`-digit code for `secret` at `date`, or nil when the secret
    /// is not base32.
    static func code(secret: String, at date: Date, digits: Int = 6) -> String? {
        guard let key = decode(secret) else { return nil }
        let counter = UInt64(floor(date.timeIntervalSince1970 / period))
        var message = counter.bigEndian
        let mac = HMAC<Insecure.SHA1>.authenticationCode(
            for: Data(bytes: &message, count: MemoryLayout<UInt64>.size),
            using: SymmetricKey(data: key)
        )
        let hash = Array(mac)
        let offset = Int(hash[hash.count - 1] & 0x0F)
        let binary = (UInt32(hash[offset] & 0x7F) << 24)
            | (UInt32(hash[offset + 1]) << 16)
            | (UInt32(hash[offset + 2]) << 8)
            | UInt32(hash[offset + 3])
        var modulus: UInt32 = 1
        for _ in 0..<digits { modulus *= 10 }
        let value = String(binary % modulus)
        return String(repeating: "0", count: max(0, digits - value.count)) + value
    }

    /// Seconds until the code for `date` stops being current.
    static func secondsLeftInWindow(at date: Date) -> TimeInterval {
        period - date.timeIntervalSince1970.truncatingRemainder(dividingBy: period)
    }
}
