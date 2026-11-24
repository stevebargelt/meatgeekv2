import Foundation
public import MeatGeekAPI
import Observation

public typealias Device = Components.Schemas.Device
public typealias Cook = Components.Schemas.Cook

// Lets SwiftUI present a sheet or dialog for a device (`.sheet(item:)`).
extension Components.Schemas.Device: Identifiable {}

/// The Devices tab: the caller's devices with their connection and active
/// cook, and renaming and releasing them. Mirrors
/// apps/web/src/devices/devices-page.tsx and device-row.tsx.
@MainActor
@Observable
public final class DevicesModel {
    public enum ListState: Equatable, Sendable {
        case loading
        /// `readAt`: when the list answered, on the injected clock. Each
        /// device's "last heard" age is measured against it (HAR-143).
        case loaded(devices: [Device], readAt: Date)
        case failed(APIProblem)
    }

    /// The caller's active cooks keyed by device id, from one
    /// `GET /cooks?status=active&limit=100` for the whole list.
    public enum ActiveCooks: Equatable, Sendable {
        case loading
        case loaded([String: Cook])
        case failed(APIProblem)
    }

    /// How a rename or a release ended.
    public enum Outcome: Equatable, Sendable {
        case done
        /// 404: the device has gone. The notice says so and the list was re-read.
        case deviceGone
        /// Refused or failed; the device is unchanged.
        case failed(APIProblem)
        /// A 401: the session is signed out.
        case sessionEnded
    }

    public nonisolated static let emptyMessage = "You have no devices yet. Claim one with the code your device shows."
    /// A refused `DELETE /devices/{id}`, by status (RELEASE_MESSAGES in device-row.tsx).
    public nonisolated static let releaseCookActiveMessage = "Stop the active cook on this device before releasing it."
    public nonisolated static let releaseBusyMessage = "The device service is busy — try again."

    public nonisolated static func notFoundMessage(deviceID: String) -> String {
        "Device \(deviceID) was not found. The list has been refreshed."
    }

    public private(set) var list: ListState = .loading
    public private(set) var activeCooks: ActiveCooks = .loading
    /// A device that went away under a rename or a release, shown above the list.
    public private(set) var notice: APIProblem?

    @ObservationIgnored let session: SessionModel
    @ObservationIgnored private let now: @Sendable () -> Date
    @ObservationIgnored private var started = false

    /// - Parameter now: the clock "last heard" ages are measured on, read once
    ///   each time the list answers. Nothing ticks.
    public init(session: SessionModel, now: @escaping @Sendable () -> Date = { Date() }) {
        self.session = session
        self.now = now
    }

    /// The first time the tab shows: the list, then the active cooks. Later
    /// calls do nothing; `refresh()` re-reads.
    public func start() async {
        guard !started else { return }
        started = true
        await loadList()
        await loadActiveCooks()
    }

    /// Pull to refresh: clears the notice and re-reads the list and the
    /// active cooks.
    public func refresh() async {
        notice = nil
        await loadList()
        await loadActiveCooks()
    }

    // MARK: What the screens show

    public var devices: [Device] {
        if case .loaded(let devices, _) = list { return devices }
        return []
    }

    public func device(id: String) -> Device? {
        devices.first { $0.id == id }
    }

    /// The device's connection, aged against when the list was read.
    public func connectionText(for device: Device) -> String {
        guard case .loaded(_, let readAt) = list else { return ConnectionText.unknown }
        return ConnectionText.text(device.connection, now: readAt)
    }

    /// The device's active cook, when the lookup found one.
    public func activeCook(for device: Device) -> Cook? {
        guard case .loaded(let cooks) = activeCooks else { return nil }
        return cooks[device.id]
    }

    /// "Cooking: <cook name>" when the device has an active cook.
    public func cookingText(for device: Device) -> String? {
        activeCook(for: device).map { "Cooking: \($0.name)" }
    }

    /// A cook was started or stopped (`CooksModel.apply(_:)`): an active cook
    /// becomes its device's; a stopped one stops being it. Nothing changes
    /// while the lookup has not answered or has failed.
    public func apply(_ cook: Cook) {
        guard case .loaded(var cooks) = activeCooks else { return }
        if cook.status == .active {
            cooks[cook.deviceId] = cook
        } else if cooks[cook.deviceId]?.id == cook.id {
            cooks[cook.deviceId] = nil
        }
        activeCooks = .loaded(cooks)
    }

    /// Why the active cooks are not shown, once the list is.
    public var activeCooksProblem: APIProblem? {
        guard case .loaded = list, case .failed(let problem) = activeCooks else { return nil }
        return problem.with(message: "Could not check which devices are cooking: \(problem.message)")
    }

    // MARK: Changes

    /// `PATCH /devices/{id}` with the new name (already checked and
    /// trimmed by `RenameDeviceModel`). On success the list is re-read.
    public func rename(deviceID: String, to name: String) async -> Outcome {
        let output: Operations.UpdateDevice.Output
        do {
            output = try await session.perform { api in
                try await api.updateDevice(path: .init(id: deviceID), body: .json(.init(name: name)))
            }
        } catch SessionError.sessionEnded {
            return .sessionEnded
        } catch {
            return .failed(APIProblem(error: error))
        }
        switch output {
        case .ok:
            notice = nil
            await loadList()
            return .done
        case .notFound(let response):
            return await deviceGone(deviceID, APIProblem(status: 404, body: try? response.body.json))
        case .unauthorized:
            session.endSession()
            return .sessionEnded
        case .badRequest(let response):
            return .failed(APIProblem(status: 400, body: try? response.body.json))
        case .conflict(let response):
            return .failed(APIProblem(status: 409, body: try? response.body.json))
        case .internalServerError(let response):
            return .failed(APIProblem(status: 500, body: try? response.body.json))
        case .undocumented(let status, _):
            return .failed(APIProblem(status: status, body: nil))
        }
    }

    /// `DELETE /devices/{id}`. A 204 takes the device off the list without
    /// re-reading it.
    public func release(deviceID: String) async -> Outcome {
        let output: Operations.DeleteDevice.Output
        do {
            output = try await session.perform { api in try await api.deleteDevice(path: .init(id: deviceID)) }
        } catch SessionError.sessionEnded {
            return .sessionEnded
        } catch {
            return .failed(APIProblem(error: error))
        }
        switch output {
        case .noContent:
            notice = nil
            if case .loaded(let devices, let readAt) = list {
                list = .loaded(devices: devices.filter { $0.id != deviceID }, readAt: readAt)
            }
            return .done
        case .notFound(let response):
            return await deviceGone(deviceID, APIProblem(status: 404, body: try? response.body.json))
        case .unauthorized:
            session.endSession()
            return .sessionEnded
        case .conflict(let response):
            let problem = APIProblem(status: 409, body: try? response.body.json)
            return .failed(
                problem.code == Components.Schemas.ErrorCode.cookActive.rawValue
                    ? problem.with(message: Self.releaseCookActiveMessage)
                    : problem
            )
        case .serviceUnavailable(let response):
            return .failed(
                APIProblem(status: 503, body: try? response.body.json).with(message: Self.releaseBusyMessage)
            )
        case .forbidden(let response):
            return .failed(APIProblem(status: 403, body: try? response.body.json))
        case .internalServerError(let response):
            return .failed(APIProblem(status: 500, body: try? response.body.json))
        case .undocumented(let status, _):
            return .failed(APIProblem(status: status, body: nil))
        }
    }

    /// A device was claimed: back on the list, which is read again so it
    /// shows the new device as the API has it.
    public func claimed() async {
        notice = nil
        await loadList()
    }

    // MARK: Reads

    /// `GET /devices`. A re-read keeps the current list on screen until the
    /// answer arrives.
    func loadList() async {
        do {
            let output = try await session.perform { api in try await api.getDevices() }
            switch output {
            case .ok(let ok):
                list = .loaded(devices: try ok.body.json.devices, readAt: now())
            case .unauthorized:
                session.endSession()
            case .internalServerError(let response):
                list = .failed(APIProblem(status: 500, body: try? response.body.json))
            case .undocumented(let status, _):
                list = .failed(APIProblem(status: status, body: nil))
            }
        } catch SessionError.sessionEnded {
            // Signed out; the root screen says why.
        } catch {
            list = .failed(APIProblem(error: error))
        }
    }

    /// One `GET /cooks?status=active&limit=100` for the page, not one per
    /// device. A user has at most one active cook per device; 100 is the
    /// API's largest page.
    func loadActiveCooks() async {
        do {
            let output = try await session.perform { api in
                try await api.listCooks(query: .init(status: .active, limit: 100))
            }
            switch output {
            case .ok(let ok):
                let cooks = try ok.body.json.cooks
                activeCooks = .loaded(Dictionary(cooks.map { ($0.deviceId, $0) }) { first, _ in first })
            case .unauthorized:
                session.endSession()
            case .badRequest(let response):
                activeCooks = .failed(APIProblem(status: 400, body: try? response.body.json))
            case .internalServerError(let response):
                activeCooks = .failed(APIProblem(status: 500, body: try? response.body.json))
            case .undocumented(let status, _):
                activeCooks = .failed(APIProblem(status: status, body: nil))
            }
        } catch SessionError.sessionEnded {
            // Signed out; the root screen says why.
        } catch {
            activeCooks = .failed(APIProblem(error: error))
        }
    }

    private func deviceGone(_ deviceID: String, _ problem: APIProblem) async -> Outcome {
        notice = problem.with(message: Self.notFoundMessage(deviceID: deviceID))
        await loadList()
        return .deviceGone
    }
}
