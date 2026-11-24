import Foundation
public import MeatGeekAPI

/// The devices UI test mode serves, held in memory for one launch of the app:
/// two seeded devices, a claim that succeeds for one device id and code, and
/// rename and release that change the list. Behaves like the API's device
/// routes for the cases the UI tests drive (apps/api/src/functions/devices).
///
/// Every timestamp comes from `now`, so the list's "last heard" text is the
/// same on every run when the app measures ages on the same clock
/// (`UITestMode.fixedNow`).
public actor StubDevices {
    /// The seeded device the hub heard from 12 s before `now`.
    public static let connectedID = "sim-device-1"
    public static let connectedName = "Backyard Smoker"
    /// The seeded device the hub has never heard from.
    public static let neverHeardID = "sim-device-2"
    public static let neverHeardName = "Garage Kettle"
    /// The one device id and code a claim succeeds with; any other code is 403.
    public static let claimableID = "sim-device-3"
    public static let claimCode = "ABCD-EFGH-JKLM"
    public static let requestID = "stub-request-id"
    static let userID = "tid:oid"

    private let now: @Sendable () -> Date
    private var devices: [Device]

    public init(now: @escaping @Sendable () -> Date) {
        self.now = now
        let at = now()
        devices = [
            Device(
                id: Self.connectedID, userId: Self.userID, name: Self.connectedName, model: "MeatGeek V1",
                location: "Patio", isActive: true, claimedAt: at.addingTimeInterval(-7 * 86_400),
                connection: .init(state: .connected, lastActivityAt: at.addingTimeInterval(-12))
            ),
            Device(
                id: Self.neverHeardID, userId: Self.userID, name: Self.neverHeardName, model: "MeatGeek V1",
                isActive: true, claimedAt: at.addingTimeInterval(-86_400),
                connection: .init(state: .disconnected, lastActivityAt: nil)
            ),
        ]
    }

    /// `GET /devices`: sorted by name.
    public func list() -> Operations.GetDevices.Output {
        .ok(.init(body: .json(.init(devices: devices.sorted { $0.name < $1.name }))))
    }

    /// `POST /devices/claim`. The code is compared the way the API reads it:
    /// case, spaces and hyphens do not matter.
    public func claim(_ input: Operations.ClaimDevice.Input) -> Operations.ClaimDevice.Output {
        guard case .json(let request) = input.body else { return .undocumented(statusCode: 415, .init()) }
        guard request.deviceId == Self.claimableID, normalized(request.claimCode) == normalized(Self.claimCode)
        else {
            return .forbidden(.init(body: .json(error(.claimRefused, "Device could not be claimed with that code"))))
        }
        if let existing = devices.first(where: { $0.id == request.deviceId }) {
            return .ok(.init(body: .json(existing)))
        }
        let name = request.name.trimmingCharacters(in: .whitespacesAndNewlines)
        if devices.contains(where: { $0.name == name }) {
            return .conflict(.init(body: .json(error(.deviceConflict, "You already have a device with this name."))))
        }
        let at = now()
        let device = Device(
            id: request.deviceId, userId: Self.userID, name: name, model: request.model ?? "MeatGeek",
            location: request.location, isActive: true, claimedAt: at,
            connection: .init(state: .connected, lastActivityAt: at.addingTimeInterval(-3))
        )
        devices.append(device)
        return .created(.init(body: .json(device)))
    }

    /// `PATCH /devices/{id}`: name and location.
    public func update(_ input: Operations.UpdateDevice.Input) -> Operations.UpdateDevice.Output {
        guard case .json(let request) = input.body else { return .undocumented(statusCode: 415, .init()) }
        guard let index = devices.firstIndex(where: { $0.id == input.path.id }) else {
            return .notFound(.init(body: .json(error(.deviceNotFound, "Device not found"))))
        }
        if let name = request.name?.trimmingCharacters(in: .whitespacesAndNewlines) {
            if devices.contains(where: { $0.name == name && $0.id != input.path.id }) {
                return .conflict(.init(body: .json(error(.deviceConflict, "You already have a device with this name."))))
            }
            devices[index].name = name
        }
        if let location = request.location { devices[index].location = location }
        return .ok(.init(body: .json(devices[index])))
    }

    /// `DELETE /devices/{id}`.
    public func release(_ input: Operations.DeleteDevice.Input) -> Operations.DeleteDevice.Output {
        guard let index = devices.firstIndex(where: { $0.id == input.path.id }) else {
            return .notFound(.init(body: .json(error(.deviceNotFound, "Device not found"))))
        }
        devices.remove(at: index)
        return .noContent(.init())
    }

    private func normalized(_ code: String) -> String {
        String(code.filter { !($0.isWhitespace || $0 == "-") }).uppercased()
    }

    private func error(_ code: Components.Schemas.ErrorCode, _ message: String) -> Components.Schemas.ErrorResponse {
        .init(error: code, message: message, requestId: Self.requestID)
    }
}
