import Foundation
import MeatGeekAPI
import Testing
@testable import MeatGeekKit

/// The Devices tab's logic, on `StubAPI` and a fixed clock. Mirrors the web
/// app's specs in apps/web/src/devices. No test reads the wall clock: every
/// age is measured against `fixedNow`, and every step is awaited.

/// 2026-11-22T18:00:00Z, the web specs' NOW.
let fixedNow = Date(timeIntervalSince1970: 1_795_370_400)

/// `fixedNow` less `seconds`, as the API sends `lastActivityAt`.
func before(_ seconds: TimeInterval) -> Date { fixedNow.addingTimeInterval(-seconds) }

@Suite("Connection text")
struct ConnectionTextTests {
    typealias Connection = Components.Schemas.DeviceConnection

    @Test("Connected, plus the age when the hub has heard from the device")
    func connected() {
        #expect(ConnectionText.text(Connection(state: .connected, lastActivityAt: before(12)), now: fixedNow)
            == "Connected · last heard 12 s ago")
        #expect(ConnectionText.text(Connection(state: .connected, lastActivityAt: nil), now: fixedNow)
            == "Connected")
    }

    @Test("Offline · last heard <age> ago")
    func offlineHeard() {
        #expect(ConnectionText.text(Connection(state: .disconnected, lastActivityAt: before(184)), now: fixedNow)
            == "Offline · last heard 3 min 4 s ago")
        #expect(ConnectionText.text(
            Connection(state: .disconnected, lastActivityAt: before(26 * 3600)), now: fixedNow
        ) == "Offline · last heard 26 h 0 min ago")
    }

    @Test("Offline · never heard from")
    func neverHeard() {
        #expect(ConnectionText.text(Connection(state: .disconnected, lastActivityAt: nil), now: fixedNow)
            == "Offline · never heard from")
    }

    @Test("Status unknown, for an unknown state or no connection at all")
    func unknown() {
        #expect(ConnectionText.text(Connection(state: .unknown, lastActivityAt: nil), now: fixedNow)
            == "Status unknown")
        #expect(ConnectionText.text(nil, now: fixedNow) == "Status unknown")
    }

    @Test("a hub clock ahead of ours reads as 0 s, never a negative age")
    func clockAhead() {
        #expect(ConnectionText.text(Connection(state: .connected, lastActivityAt: before(-5)), now: fixedNow)
            == "Connected · last heard 0 s ago")
    }

    @Test("durations: seconds, minutes and seconds, hours and minutes", arguments: [
        (0.0, "0 s"), (0.999, "0 s"), (12.0, "12 s"), (59.999, "59 s"), (60.0, "1 min 0 s"),
        (100.0, "1 min 40 s"), (3599.0, "59 min 59 s"), (3600.0, "1 h 0 min"), (7500.0, "2 h 5 min"),
        (-3.0, "0 s"),
    ])
    func durations(seconds: Double, text: String) {
        #expect(DurationText.text(seconds) == text)
    }

    @Test("an age of exactly 12 s on millisecond dates is 12 s, not 11")
    func millisecondDates() throws {
        let decoder = APIClientFactory.makeJSONDecoder()
        let heard = try decoder.decode(Date.self, from: Data(#""2026-11-22T17:59:48.123Z""#.utf8))
        let now = try decoder.decode(Date.self, from: Data(#""2026-11-22T18:00:00.123Z""#.utf8))
        #expect(ConnectionText.lastHeard(heard, now: now) == "last heard 12 s ago")
    }
}

@Suite("Claim code and device validation")
struct DeviceValidationTests {
    @Test("the code shows upper case in groups of four, whatever separators were typed", arguments: [
        ("", ""),
        ("7k3m", "7K3M"),
        ("7k3m9", "7K3M-9"),
        ("7K3M-", "7K3M"),
        ("7k3m9qxr2htv", "7K3M-9QXR-2HTV"),
        ("7k3m-9qxr-2htv", "7K3M-9QXR-2HTV"),
        ("7k3m 9qxr  2htv", "7K3M-9QXR-2HTV"),
        (" 7K3M\t9QXR-2HTV ", "7K3M-9QXR-2HTV"),
        // Not judged here: the API reads O as 0 and refuses U, and says so.
        ("oooo-uuuu-iiii", "OOOO-UUUU-IIII"),
        ("7K3M9QXR2HTVX", "7K3M-9QXR-2HTV-X"),
        ("7K3M.9QX", "7K3M-.9QX"),
    ])
    func formatsCode(raw: String, shown: String) {
        #expect(ClaimCode.format(raw) == shown)
    }

    @Test("keeps the caret after the same symbols")
    func caret() {
        // Typed a 5th symbol at the end: the caret goes past the new hyphen.
        #expect(ClaimCode.format("7K3M9", cursor: 5) == ("7K3M-9", 6))
        // Typed `x` in the middle of the first group.
        #expect(ClaimCode.format("7Kx3M-9QXR", cursor: 3) == ("7KX3-M9QX-R", 3))
        // Typed at the start of the second group.
        #expect(ClaimCode.format("7K3M-q9QXR", cursor: 6) == ("7K3M-Q9QX-R", 6))
        // Deleted the hyphen: the caret stays at the end of the first group.
        #expect(ClaimCode.format("7K3M9QXR", cursor: 4) == ("7K3M-9QXR", 4))
        #expect(ClaimCode.format("7K3M", cursor: 0) == ("7K3M", 0))
    }

    static let valid = ClaimInput(deviceID: "meatgeek3", claimCode: "7K3M-9QXR-2HTV", name: "Box", location: "")

    @Test("a complete claim passes")
    func validClaim() {
        #expect(DeviceValidation.claim(Self.valid).isEmpty)
    }

    @Test("requires a code, and separators alone are none")
    func codeRequired() {
        var input = Self.valid
        input.claimCode = " - "
        #expect(DeviceValidation.claim(input) == ClaimFieldErrors(claimCode: "Claim code is required."))
    }

    @Test("checks the device id, name and location like the API")
    func everyField() {
        let errors = DeviceValidation.claim(ClaimInput(
            deviceID: "has spaces", claimCode: "x",
            name: String(repeating: "n", count: 101), location: String(repeating: "l", count: 201)
        ))
        #expect(errors == ClaimFieldErrors(
            deviceID: "Device ID must be 1-128 characters: letters, digits, and . _ : -",
            name: "Name must be at most 100 characters.",
            location: "Location must be at most 200 characters."
        ))
    }

    @Test("every message: empty fields, a blank name, the id's length and characters")
    func messages() {
        #expect(DeviceValidation.claim(ClaimInput()) == ClaimFieldErrors(
            deviceID: "Device ID must be 1-128 characters: letters, digits, and . _ : -",
            claimCode: "Claim code is required.",
            name: "Name is required."
        ))
        #expect(DeviceValidation.label("Name", "   ") == "Name is required.")
        #expect(DeviceValidation.label("Name", " " + String(repeating: "n", count: 100) + " ") == nil)
        #expect(DeviceValidation.deviceID(String(repeating: "a", count: 128)) == nil)
        #expect(DeviceValidation.deviceID(String(repeating: "a", count: 129)) != nil)
        #expect(DeviceValidation.deviceID("Az09._:-") == nil)
        #expect(DeviceValidation.deviceID("é") != nil)
        #expect(DeviceValidation.location(" " + String(repeating: "l", count: 200) + " ") == nil)
    }
}

// MARK: - Models

/// Counts what the stub API was asked, from any task.
final class Calls: @unchecked Sendable {
    private let lock = NSLock()
    private var names: [String] = []
    private var bodies: [Components.Schemas.ClaimDeviceRequest] = []
    private var queries: [Operations.ListCooks.Input.Query] = []

    func record(_ name: String) { lock.withLock { names.append(name) } }
    func record(claim body: Components.Schemas.ClaimDeviceRequest) { lock.withLock { bodies.append(body) } }
    func record(cooks query: Operations.ListCooks.Input.Query) { lock.withLock { queries.append(query) } }
    func count(_ name: String) -> Int { lock.withLock { names.filter { $0 == name }.count } }
    var claims: [Components.Schemas.ClaimDeviceRequest] { lock.withLock { bodies } }
    var cookQueries: [Operations.ListCooks.Input.Query] { lock.withLock { queries } }
}

/// A clock fixed at `fixedNow` that counts its reads.
final class FixedClock: @unchecked Sendable {
    private let lock = NSLock()
    private var reads = 0
    var readCount: Int { lock.withLock { reads } }
    var now: @Sendable () -> Date {
        { self.lock.withLock { self.reads += 1 }; return fixedNow }
    }
}

enum DeviceFixtures {
    static let account = SignedInAccount(displayName: "Account Name")
    static let ended = SessionModel.State.signedOut(message: "Your session ended. Sign in again.")

    static func device(
        _ id: String, _ name: String,
        connection: Components.Schemas.DeviceConnection? = .init(state: .connected, lastActivityAt: before(12))
    ) -> Device {
        Device(id: id, userId: "tid:oid", name: name, model: "MeatGeek V1", isActive: true, connection: connection)
    }

    static let box = device("box", "Brisket Box")
    static let kettle = device("kettle", "Kettle", connection: .init(state: .disconnected, lastActivityAt: nil))

    static func error(
        _ code: Components.Schemas.ErrorCode, _ message: String, _ requestID: String = "req-1"
    ) -> Components.Schemas.ErrorResponse {
        .init(error: code, message: message, requestId: requestID)
    }

    static let unauthorized = Components.Responses.Unauthenticated(body: .json(.init(
        error: .unauthenticated, reason: .principalHeaderMissing, requestId: "req-401"
    )))

    /// A stub whose `GET /devices` answers `devices()` (re-read on every call)
    /// and whose `GET /cooks` lists none, recording calls in `calls`.
    static func api(
        calls: Calls,
        devices: @escaping @Sendable () -> [Device] = { [box, kettle] }
    ) -> StubAPI {
        var api = StubAPI()
        api.getDevicesHandler = { _ in
            calls.record("getDevices")
            return .ok(.init(body: .json(.init(devices: devices()))))
        }
        api.listCooksHandler = { input in
            calls.record("listCooks")
            calls.record(cooks: input.query)
            return .ok(.init(body: .json(.init(cooks: [], limit: 100, hasMore: false))))
        }
        return api
    }

    /// A signed-in session over `api`, and a devices model on a fixed clock
    /// that has loaded once.
    @MainActor
    static func loaded(_ api: StubAPI, clock: FixedClock = FixedClock()) async -> (SessionModel, DevicesModel) {
        let session = SessionModel(tokenProvider: FakeTokenProvider(account: account), api: api)
        await session.restore()
        let model = DevicesModel(session: session, now: clock.now)
        await model.start()
        return (session, model)
    }
}

/// Holds a device list a test changes between reads.
final class DeviceList: @unchecked Sendable {
    private let lock = NSLock()
    private var devices: [Device]
    init(_ devices: [Device]) { self.devices = devices }
    var current: [Device] { lock.withLock { devices } }
    func set(_ devices: [Device]) { lock.withLock { self.devices = devices } }
}

@Suite("DevicesModel")
@MainActor
struct DevicesModelTests {
    typealias F = DeviceFixtures

    @Test("lists the devices, ages each connection on the clock read once when the list answered")
    func list() async {
        let calls = Calls()
        let clock = FixedClock()
        let (_, model) = await F.loaded(F.api(calls: calls), clock: clock)

        #expect(model.list == .loaded(devices: [F.box, F.kettle], readAt: fixedNow))
        #expect(model.connectionText(for: F.box) == "Connected · last heard 12 s ago")
        #expect(model.connectionText(for: F.kettle) == "Offline · never heard from")
        #expect(clock.readCount == 1)
        #expect(calls.count("getDevices") == 1)
        #expect(model.activeCooksProblem == nil)
        #expect(model.notice == nil)

        // start() again (the tab reappearing) reads nothing.
        await model.start()
        #expect(calls.count("getDevices") == 1)
    }

    @Test("an empty list is loaded with no devices; the screen shows the empty message")
    func empty() async {
        let (_, model) = await F.loaded(F.api(calls: Calls(), devices: { [] }))
        #expect(model.list == .loaded(devices: [], readAt: fixedNow))
        #expect(DevicesModel.emptyMessage == "You have no devices yet. Claim one with the code your device shows.")
    }

    @Test("a failed list read shows the API's message and request id")
    func listFails() async {
        var api = F.api(calls: Calls())
        api.getDevicesHandler = { _ in
            .internalServerError(.init(body: .json(F.error(.internalServerError, "Cosmos is down", "req-500"))))
        }
        let (_, model) = await F.loaded(api)

        let problem = APIProblem(status: 500, code: "INTERNAL_SERVER_ERROR", message: "Cosmos is down", requestID: "req-500")
        #expect(model.list == .failed(problem))
        #expect(problem.text == "Cosmos is down Request ID: req-500")
    }

    @Test("pull to refresh re-reads the list and the active cooks, and clears the notice")
    func refresh() async {
        let calls = Calls()
        let list = DeviceList([F.box])
        let (_, model) = await F.loaded(F.api(calls: calls, devices: { list.current }))
        list.set([F.box, F.kettle])

        await model.refresh()

        #expect(model.devices == [F.box, F.kettle])
        #expect(calls.count("getDevices") == 2)
        #expect(calls.count("listCooks") == 2)
    }

    @Test("one GET /cooks?status=active&limit=100 for the page; a device with an active cook says so")
    func activeCooks() async throws {
        let calls = Calls()
        var api = F.api(calls: calls)
        let cook = try APIClientFactory.makeJSONDecoder().decode(Cook.self, from: Data("""
        {"id": "c1", "userId": "tid:oid", "deviceId": "box", "name": "Sunday brisket",
         "status": "active", "startTime": "2026-11-22T12:00:00.000Z"}
        """.utf8))
        api.listCooksHandler = { input in
            calls.record("listCooks")
            calls.record(cooks: input.query)
            return .ok(.init(body: .json(.init(cooks: [cook], limit: 100, hasMore: false))))
        }
        let (_, model) = await F.loaded(api)

        #expect(model.cookingText(for: F.box) == "Cooking: Sunday brisket")
        #expect(model.cookingText(for: F.kettle) == nil)
        #expect(calls.cookQueries == [.init(status: .active, limit: 100)])
    }

    @Test("a failed active-cook lookup says so and still shows the list")
    func activeCooksFail() async {
        var api = F.api(calls: Calls())
        api.listCooksHandler = { _ in
            .internalServerError(.init(body: .json(F.error(.internalServerError, "Cosmos is down", "req-c"))))
        }
        let (_, model) = await F.loaded(api)

        #expect(model.devices == [F.box, F.kettle])
        #expect(model.activeCooksProblem?.message == "Could not check which devices are cooking: Cosmos is down")
        #expect(model.activeCooksProblem?.requestID == "req-c")
        #expect(model.cookingText(for: F.box) == nil)
    }

    @Test("a thrown active-cook lookup says so with the error's description")
    func activeCooksThrow() async {
        var api = F.api(calls: Calls())
        api.listCooksHandler = { _ in throw APIProblem(message: "The Internet connection appears to be offline.") }
        let (_, model) = await F.loaded(api)

        #expect(model.activeCooksProblem?.message
            == "Could not check which devices are cooking: The Internet connection appears to be offline.")
    }

    @Test("a 401 on the list signs the session out")
    func listUnauthorized() async {
        var api = F.api(calls: Calls())
        api.getDevicesHandler = { _ in .unauthorized(F.unauthorized) }
        let (session, model) = await F.loaded(api)

        #expect(session.state == F.ended)
        #expect(model.list == .loading)
    }

    @Test("a 401 on the active-cook lookup signs the session out")
    func cooksUnauthorized() async {
        var api = F.api(calls: Calls())
        api.listCooksHandler = { _ in .unauthorized(F.unauthorized) }
        let (session, _) = await F.loaded(api)

        #expect(session.state == F.ended)
    }

    // MARK: Release

    @Test("release 204 takes the device off the list without re-reading it")
    func release() async {
        let calls = Calls()
        var api = F.api(calls: calls)
        api.deleteDeviceHandler = { input in
            calls.record("deleteDevice:\(input.path.id)")
            return .noContent(.init())
        }
        let (_, model) = await F.loaded(api)

        #expect(await model.release(deviceID: "box") == .done)

        #expect(model.devices == [F.kettle])
        #expect(calls.count("deleteDevice:box") == 1)
        #expect(calls.count("getDevices") == 1)
    }

    @Test("release 404 says the device was not found and re-reads the list")
    func releaseNotFound() async {
        let calls = Calls()
        let list = DeviceList([F.box, F.kettle])
        var api = F.api(calls: calls, devices: { list.current })
        api.deleteDeviceHandler = { _ in
            list.set([F.kettle])
            return .notFound(.init(body: .json(F.error(.deviceNotFound, "Device not found", "req-404"))))
        }
        let (_, model) = await F.loaded(api)

        #expect(await model.release(deviceID: "box") == .deviceGone)

        #expect(model.notice == APIProblem(
            status: 404, code: "DEVICE_NOT_FOUND",
            message: "Device box was not found. The list has been refreshed.", requestID: "req-404"
        ))
        #expect(model.devices == [F.kettle])
        #expect(calls.count("getDevices") == 2)

        // The next refresh clears the notice.
        await model.refresh()
        #expect(model.notice == nil)
    }

    @Test("release 409 COOK_ACTIVE says to stop the cook first and keeps the device")
    func releaseCookActive() async {
        var api = F.api(calls: Calls())
        api.deleteDeviceHandler = { _ in
            .conflict(.init(body: .json(F.error(.cookActive, "Stop the active cook before releasing this device"))))
        }
        let (_, model) = await F.loaded(api)

        let outcome = await model.release(deviceID: "box")

        #expect(outcome == .failed(APIProblem(
            status: 409, code: "COOK_ACTIVE",
            message: "Stop the active cook on this device before releasing it.", requestID: "req-1"
        )))
        #expect(model.devices == [F.box, F.kettle])
    }

    @Test("release 503 says to try again")
    func releaseBusy() async {
        var api = F.api(calls: Calls())
        api.deleteDeviceHandler = { _ in
            .serviceUnavailable(.init(body: .json(.init(
                error: .deviceTwinUpdateFailed, message: "The device twin could not be patched.",
                reason: "twin_patch_failed", requestId: "req-503"
            ))))
        }
        let (_, model) = await F.loaded(api)

        #expect(await model.release(deviceID: "box") == .failed(APIProblem(
            status: 503, code: "DEVICE_TWIN_UPDATE_FAILED",
            message: "The device service is busy — try again.", requestID: "req-503"
        )))
    }

    @Test("release 401 signs the session out")
    func releaseUnauthorized() async {
        var api = F.api(calls: Calls())
        api.deleteDeviceHandler = { _ in .unauthorized(F.unauthorized) }
        let (session, model) = await F.loaded(api)

        #expect(await model.release(deviceID: "box") == .sessionEnded)
        #expect(session.state == F.ended)
    }

    // MARK: Rename

    @Test("rename checks the name: required, and at most 100 characters after trimming")
    func renameValidation() async {
        let calls = Calls()
        var api = F.api(calls: calls)
        api.updateDeviceHandler = { _ in
            calls.record("updateDevice")
            return .ok(.init(body: .json(F.box)))
        }
        let (_, model) = await F.loaded(api)
        let rename = RenameDeviceModel(device: F.box, devices: model)
        #expect(rename.name == "Brisket Box")

        rename.name = "   "
        #expect(await rename.save() == false)
        #expect(rename.problem == APIProblem(message: "Name is required."))

        rename.name = String(repeating: "n", count: 101)
        #expect(await rename.save() == false)
        #expect(rename.problem == APIProblem(message: "Name must be at most 100 characters."))

        #expect(calls.count("updateDevice") == 0)
    }

    @Test("rename sends the trimmed name, then re-reads the list")
    func rename() async throws {
        let calls = Calls()
        let list = DeviceList([F.box, F.kettle])
        var api = F.api(calls: calls, devices: { list.current })
        let sent = Calls()
        api.updateDeviceHandler = { input in
            guard case .json(let body) = input.body else { throw APIProblem(message: "no body") }
            sent.record("\(input.path.id)=\(body.name ?? "nil")")
            let renamed = F.device("box", body.name ?? "")
            list.set([renamed, F.kettle])
            return .ok(.init(body: .json(renamed)))
        }
        let (_, model) = await F.loaded(api)
        let rename = RenameDeviceModel(device: F.box, devices: model)

        rename.name = "  Pork Shed  "
        #expect(await rename.save())

        #expect(sent.count("box=Pork Shed") == 1)
        #expect(calls.count("getDevices") == 2)
        #expect(model.device(id: "box")?.name == "Pork Shed")
        #expect(rename.problem == nil)
    }

    @Test("rename 404 says the device was not found, re-reads the list and closes the form")
    func renameNotFound() async {
        let calls = Calls()
        let list = DeviceList([F.box, F.kettle])
        var api = F.api(calls: calls, devices: { list.current })
        api.updateDeviceHandler = { _ in
            list.set([F.kettle])
            return .notFound(.init(body: .json(F.error(.deviceNotFound, "Device not found", "req-404"))))
        }
        let (_, model) = await F.loaded(api)
        let rename = RenameDeviceModel(device: F.box, devices: model)
        rename.name = "New"

        #expect(await rename.save())

        #expect(model.notice?.message == "Device box was not found. The list has been refreshed.")
        #expect(model.notice?.requestID == "req-404")
        #expect(model.devices == [F.kettle])
        #expect(calls.count("getDevices") == 2)
    }

    @Test("rename 409 keeps the form open with the API's message")
    func renameConflict() async {
        var api = F.api(calls: Calls())
        api.updateDeviceHandler = { _ in
            .conflict(.init(body: .json(F.error(.deviceConflict, "You already have a device with this name.", "req-409"))))
        }
        let (_, model) = await F.loaded(api)
        let rename = RenameDeviceModel(device: F.box, devices: model)
        rename.name = "Kettle"

        #expect(await rename.save() == false)
        #expect(rename.problem?.text == "You already have a device with this name. Request ID: req-409")
    }

    @Test("rename 401 signs the session out and closes the form")
    func renameUnauthorized() async {
        var api = F.api(calls: Calls())
        api.updateDeviceHandler = { _ in .unauthorized(F.unauthorized) }
        let (session, model) = await F.loaded(api)
        let rename = RenameDeviceModel(device: F.box, devices: model)

        #expect(await rename.save())
        #expect(session.state == F.ended)
    }
}

@Suite("ClaimDeviceModel")
@MainActor
struct ClaimDeviceModelTests {
    typealias F = DeviceFixtures

    static func form(
        _ api: StubAPI
    ) async -> (SessionModel, DevicesModel, ClaimDeviceModel) {
        let (session, devices) = await F.loaded(api)
        let form = ClaimDeviceModel(devices: devices, deviceID: "meatgeek3")
        form.claimCode = "7k3m-9qxr 2htv"
        form.name = "  Brisket Box "
        form.location = " Backyard "
        return (session, devices, form)
    }

    @Test("formats the code as it is typed")
    func formatsCode() async {
        let (_, _, form) = await Self.form(F.api(calls: Calls()))
        #expect(form.claimCode == "7K3M-9QXR-2HTV")
        form.claimCode = "abcd"
        #expect(form.claimCode == "ABCD")
        form.claimCode = "abcd-"
        #expect(form.claimCode == "ABCD")
    }

    @Test("checks the fields before posting")
    func validation() async {
        let calls = Calls()
        var api = F.api(calls: calls)
        api.claimDeviceHandler = { _ in
            calls.record("claimDevice")
            return .created(.init(body: .json(F.box)))
        }
        let (_, _, form) = await Self.form(api)
        form.deviceID = "has spaces"
        form.claimCode = ""
        form.name = "   "

        #expect(await form.submit() == nil)

        #expect(form.fieldErrors == ClaimFieldErrors(
            deviceID: "Device ID must be 1-128 characters: letters, digits, and . _ : -",
            claimCode: "Claim code is required.",
            name: "Name is required."
        ))
        #expect(calls.count("claimDevice") == 0)
    }

    @Test("on 201 posts {deviceId, claimCode, name, location}, clears the code and the list has the device",
          arguments: [201, 200])
    func claims(status: Int) async {
        let calls = Calls()
        let claimed = F.device("meatgeek3", "Brisket Box")
        let list = DeviceList([F.box])
        var api = F.api(calls: calls, devices: { list.current })
        api.claimDeviceHandler = { input in
            guard case .json(let body) = input.body else { throw APIProblem(message: "no body") }
            calls.record(claim: body)
            list.set([F.box, claimed])
            return status == 201 ? .created(.init(body: .json(claimed))) : .ok(.init(body: .json(claimed)))
        }
        let (_, devices, form) = await Self.form(api)

        #expect(await form.submit() == claimed)

        #expect(calls.claims == [.init(
            deviceId: "meatgeek3", claimCode: "7K3M-9QXR-2HTV", name: "Brisket Box", location: "Backyard"
        )])
        #expect(form.claimCode == "")
        #expect(form.problem == nil)
        #expect(devices.device(id: "meatgeek3") == claimed)
        #expect(calls.count("getDevices") == 2)
    }

    @Test("leaves location out when it is blank, and sends no model")
    func noLocation() async {
        let calls = Calls()
        var api = F.api(calls: calls)
        api.claimDeviceHandler = { input in
            guard case .json(let body) = input.body else { throw APIProblem(message: "no body") }
            calls.record(claim: body)
            return .created(.init(body: .json(F.box)))
        }
        let (_, _, form) = await Self.form(api)
        form.location = "   "

        _ = await form.submit()

        #expect(calls.claims.first?.location == nil)
        #expect(calls.claims.first?.model == nil)
    }

    nonisolated static let refusals: [(Int, Operations.ClaimDevice.Output, String)] = [
        (403, .forbidden(.init(body: .json(F.error(.claimRefused, "Device could not be claimed with that code", "req-403")))),
         ClaimDeviceModel.refusedMessage),
        (409, .conflict(.init(body: .json(F.error(.deviceConflict, "You already have a device with this name.", "req-409")))),
         ClaimDeviceModel.conflictMessage),
        (400, .badRequest(.init(body: .json(F.error(
            .validationError, "claimCode must be the 12-symbol code the device shows", "req-400"
        )))), "claimCode must be the 12-symbol code the device shows"),
        (503, .serviceUnavailable(.init(body: .json(.init(
            error: .deviceTwinUpdateFailed, message: "The device twin could not be read.",
            reason: "twin_read_failed", requestId: "req-503"
        )))), ClaimDeviceModel.busyMessage),
    ]

    @Test("a refused claim says why, keeps its request id and the form, and clears the code",
          arguments: refusals)
    func refused(status: Int, answer: Operations.ClaimDevice.Output, message: String) async {
        let calls = Calls()
        var api = F.api(calls: calls)
        api.claimDeviceHandler = { _ in answer }
        let (_, devices, form) = await Self.form(api)

        #expect(await form.submit() == nil)

        #expect(form.problem?.status == status)
        #expect(form.problem?.message == message)
        #expect(form.problem?.requestID == "req-\(status)")
        #expect(form.claimCode == "")
        #expect(form.deviceID == "meatgeek3")
        #expect(form.name == "  Brisket Box ")
        #expect(devices.devices == [F.box, F.kettle])
        #expect(calls.count("getDevices") == 1)
    }

    @Test("the refusal messages are the web app's")
    func messages() {
        #expect(ClaimDeviceModel.refusedMessage
            == "That code doesn't match this device, or it has expired or been used. "
            + "Run the setup command on the device again to get a fresh code.")
        #expect(ClaimDeviceModel.conflictMessage == "You already have a device with that name.")
        #expect(ClaimDeviceModel.busyMessage == "The device service is busy — try again.")
    }

    @Test("a claim that could not be sent keeps the code to try again")
    func offline() async {
        var api = F.api(calls: Calls())
        api.claimDeviceHandler = { _ in throw APIProblem(message: "The Internet connection appears to be offline.") }
        let (_, _, form) = await Self.form(api)

        #expect(await form.submit() == nil)

        #expect(form.problem == APIProblem(message: "The Internet connection appears to be offline."))
        #expect(form.claimCode == "7K3M-9QXR-2HTV")
    }

    @Test("an undocumented status says the status")
    func undocumented() async {
        var api = F.api(calls: Calls())
        api.claimDeviceHandler = { _ in .undocumented(statusCode: 502, .init()) }
        let (_, _, form) = await Self.form(api)

        #expect(await form.submit() == nil)
        #expect(form.problem == APIProblem(status: 502, message: "The request failed with HTTP 502."))
    }

    @Test("a 401 signs the session out")
    func unauthorized() async {
        var api = F.api(calls: Calls())
        api.claimDeviceHandler = { _ in .unauthorized(F.unauthorized) }
        let (session, _, form) = await Self.form(api)

        #expect(await form.submit() == nil)
        #expect(session.state == F.ended)
        #expect(form.problem == nil)
    }
}

@Suite("UI test mode's devices")
@MainActor
struct StubDevicesTests {
    @Test("two seeded devices, claim with the one code, rename, release; last heard on the fixed clock")
    func flow() async throws {
        let session = UITestMode.makeSession(environment: ["MEATGEEK_UI_TEST": "1"])
        await session.restore()
        await session.signIn()
        let model = DevicesModel(session: session, now: UITestMode.now(environment: ["MEATGEEK_UI_TEST": "1"]))
        await model.start()

        #expect(model.devices.map(\.id) == [StubDevices.connectedID, StubDevices.neverHeardID])
        let connected = try #require(model.device(id: StubDevices.connectedID))
        let neverHeard = try #require(model.device(id: StubDevices.neverHeardID))
        #expect(model.connectionText(for: connected) == "Connected · last heard 12 s ago")
        #expect(model.connectionText(for: neverHeard) == "Offline · never heard from")
        #expect(model.activeCooksProblem == nil)

        let wrong = ClaimDeviceModel(devices: model, deviceID: StubDevices.claimableID)
        wrong.claimCode = "AAAA-BBBB-CCCC"
        wrong.name = "Brisket Box"
        #expect(await wrong.submit() == nil)
        #expect(wrong.problem?.status == 403)

        let claim = ClaimDeviceModel(devices: model, deviceID: StubDevices.claimableID)
        claim.claimCode = "abcd efgh jklm"
        claim.name = "Brisket Box"
        let device = try #require(await claim.submit())
        #expect(model.device(id: StubDevices.claimableID)?.name == "Brisket Box")
        #expect(model.connectionText(for: device) == "Connected · last heard 3 s ago")

        let rename = RenameDeviceModel(device: device, devices: model)
        rename.name = "Pork Shed"
        #expect(await rename.save())
        #expect(model.device(id: StubDevices.claimableID)?.name == "Pork Shed")

        #expect(await model.release(deviceID: StubDevices.claimableID) == .done)
        #expect(model.device(id: StubDevices.claimableID) == nil)
        #expect(await model.release(deviceID: StubDevices.claimableID) == .deviceGone)
    }

    @Test("UI test mode's clock is fixed; the app's own is the device's")
    func clock() {
        #expect(UITestMode.now(environment: ["MEATGEEK_UI_TEST": "1"])() == UITestMode.fixedNow)
        #expect(UITestMode.fixedNow == fixedNow)
    }
}
