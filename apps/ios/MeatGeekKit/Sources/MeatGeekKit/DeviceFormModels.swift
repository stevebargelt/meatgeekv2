import Foundation
public import MeatGeekAPI
import Observation

/// The claim form: device ID, claim code, name and location, checked before
/// `POST /devices/claim`. Mirrors apps/web/src/devices/claim-device-page.tsx.
@MainActor
@Observable
public final class ClaimDeviceModel {
    /// What each refusal says (CLAIM_MESSAGES). Every 403 is the same, as the
    /// API intends.
    public nonisolated static let refusedMessage =
        "That code doesn't match this device, or it has expired or been used. "
        + "Run the setup command on the device again to get a fresh code."
    public nonisolated static let conflictMessage = "You already have a device with that name."
    public nonisolated static let busyMessage = "The device service is busy — try again."

    public var deviceID: String
    /// Formatted as typed: upper case, `XXXX-XXXX-XXXX`, spaces and hyphens
    /// ignored (`ClaimCode.format`).
    public var claimCode: String {
        get { code }
        set { code = ClaimCode.format(newValue) }
    }
    public var name = ""
    public var location = ""

    public private(set) var fieldErrors = ClaimFieldErrors()
    /// Why the API refused the claim, or why it could not be sent.
    public private(set) var problem: APIProblem?
    public private(set) var submitting = false

    private var code = ""
    @ObservationIgnored private let devices: DevicesModel

    public init(devices: DevicesModel, deviceID: String = "") {
        self.devices = devices
        self.deviceID = deviceID
    }

    /// Checks the fields, then claims. Returns the device once claimed, after
    /// the devices list has been re-read with it; nil while the form stays.
    ///
    /// The code is held only here, and is cleared once the API has answered,
    /// whether it took the code or refused it: a refused code is spent or
    /// wrong, and the device prints a fresh one.
    public func submit() async -> Device? {
        guard !submitting else { return nil }
        problem = nil
        fieldErrors = DeviceValidation.claim(
            ClaimInput(deviceID: deviceID, claimCode: claimCode, name: name, location: location)
        )
        guard fieldErrors.isEmpty else { return nil }

        // The code goes as typed: the API normalizes it. No model: the API
        // stores "MeatGeek".
        let trimmedLocation = DeviceValidation.trimmed(location)
        let body = Components.Schemas.ClaimDeviceRequest(
            deviceId: deviceID,
            claimCode: claimCode,
            name: DeviceValidation.trimmed(name),
            location: trimmedLocation.isEmpty ? nil : trimmedLocation
        )

        submitting = true
        defer { submitting = false }
        let output: Operations.ClaimDevice.Output
        do {
            output = try await devices.session.perform { api in try await api.claimDevice(body: .json(body)) }
        } catch SessionError.sessionEnded {
            return nil
        } catch {
            problem = APIProblem(error: error)
            return nil
        }

        code = ""
        switch output {
        case .created(let created):
            return await claimed(try? created.body.json)
        case .ok(let ok):
            return await claimed(try? ok.body.json)
        case .unauthorized:
            devices.session.endSession()
        case .badRequest(let response):
            problem = APIProblem(status: 400, body: try? response.body.json)
        case .forbidden(let response):
            problem = APIProblem(status: 403, body: try? response.body.json).with(message: Self.refusedMessage)
        case .conflict(let response):
            problem = APIProblem(status: 409, body: try? response.body.json).with(message: Self.conflictMessage)
        case .serviceUnavailable(let response):
            problem = APIProblem(status: 503, body: try? response.body.json).with(message: Self.busyMessage)
        case .internalServerError(let response):
            problem = APIProblem(status: 500, body: try? response.body.json)
        case .undocumented(let status, _):
            problem = APIProblem(status: status, body: nil)
        }
        return nil
    }

    private func claimed(_ device: Device?) async -> Device? {
        guard let device else {
            problem = APIProblem(message: "The device was claimed, but the answer could not be read.")
            await devices.claimed()
            return nil
        }
        await devices.claimed()
        return device
    }
}

/// Renaming one device: the new name, checked (1-100 characters after
/// trimming) before `PATCH /devices/{id}`. Mirrors the rename form in
/// apps/web/src/devices/device-row.tsx.
@MainActor
@Observable
public final class RenameDeviceModel {
    public let deviceID: String
    public var name: String
    public private(set) var problem: APIProblem?
    public private(set) var saving = false

    @ObservationIgnored private let devices: DevicesModel

    public init(device: Device, devices: DevicesModel) {
        self.deviceID = device.id
        self.name = device.name
        self.devices = devices
    }

    /// Saves the name. True when the rename form should close: renamed, the
    /// device has gone (the list's notice says so), or the session ended.
    public func save() async -> Bool {
        guard !saving else { return false }
        if let invalid = DeviceValidation.label("Name", name) {
            problem = APIProblem(message: invalid)
            return false
        }
        problem = nil
        saving = true
        defer { saving = false }
        switch await devices.rename(deviceID: deviceID, to: DeviceValidation.trimmed(name)) {
        case .done, .deviceGone, .sessionEnded:
            return true
        case .failed(let problem):
            self.problem = problem
            return false
        }
    }
}
