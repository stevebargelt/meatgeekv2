import MeatGeekAPI
import MeatGeekKit
import SwiftUI

/// The Devices tab: the list, pull to refresh, claim (+), and per-device
/// start cook, rename and release (swipe, context menu, or the detail
/// screen). A device's active cook opens from its "Cooking: <name>".
struct DevicesView: View {
    let model: DevicesModel
    let cooks: CooksModel
    let profile: ProfileModel
    let session: SessionModel

    @State private var path: [Route] = []
    @State private var claiming = false
    @State private var starting: Device?
    @State private var renaming: Device?
    @State private var releasing: Device?

    var body: some View {
        NavigationStack(path: $path) {
            List {
                if let notice = model.notice {
                    ProblemText(problem: notice)
                        .accessibilityIdentifier(AccessibilityID.devicesNotice)
                }
                if let problem = model.activeCooksProblem {
                    ProblemText(problem: problem)
                        .accessibilityIdentifier(AccessibilityID.devicesCooksProblem)
                }
                content
            }
            .navigationTitle("Devices")
            .routes(devices: model, cooks: cooks, path: $path)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    AccountMenu(profile: profile, session: session)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Claim a device", systemImage: "plus") { claiming = true }
                        .accessibilityIdentifier(AccessibilityID.claimDevice)
                }
            }
            .refreshable { await model.refresh() }
            .task { await model.start() }
            .sheet(isPresented: $claiming) {
                ClaimDeviceView(model: ClaimDeviceModel(devices: model))
            }
            .sheet(item: $renaming) { device in
                RenameDeviceView(model: RenameDeviceModel(device: device, devices: model))
            }
            .startCookSheet(device: $starting, cooks: cooks, path: $path)
            .releaseConfirmation(model: model, device: $releasing)
        }
    }

    @ViewBuilder
    private var content: some View {
        switch model.list {
        case .loading:
            ProgressView("Loading devices…")
                .frame(maxWidth: .infinity)
                .accessibilityIdentifier(AccessibilityID.devicesLoading)
        case .failed(let problem):
            VStack(alignment: .leading, spacing: 12) {
                ProblemText(problem: problem)
                    .accessibilityIdentifier(AccessibilityID.devicesError)
                Button("Try again") { Task { await model.refresh() } }
            }
        case .loaded(let devices, _) where devices.isEmpty:
            Text(DevicesModel.emptyMessage)
                .foregroundStyle(.secondary)
                .accessibilityIdentifier(AccessibilityID.devicesEmpty)
        case .loaded(let devices, _):
            ForEach(devices) { device in
                let active = model.activeCook(for: device)
                NavigationLink(value: Route.device(device.id)) {
                    DeviceRow(model: model, device: device) { path.append(.cook($0)) }
                }
                .accessibilityIdentifier(AccessibilityID.deviceRow(device.id))
                .swipeActions(edge: .leading) {
                    if active == nil {
                        Button("Start cook") { starting = device }
                            .tint(.green)
                            .accessibilityIdentifier(AccessibilityID.deviceStartCook(device.id))
                    }
                }
                .swipeActions {
                    // Not `role: .destructive`: List would take the row away
                    // at once, before the confirmation is answered.
                    Button("Release") { releasing = device }
                        .tint(.red)
                        .accessibilityIdentifier(AccessibilityID.deviceRelease(device.id))
                    Button("Rename") { renaming = device }
                        .tint(.accentColor)
                        .accessibilityIdentifier(AccessibilityID.deviceRename(device.id))
                }
                .contextMenu {
                    if let active {
                        Button("Open \(active.name)", systemImage: "list.bullet.rectangle") {
                            path.append(.cook(active.id))
                        }
                    } else {
                        Button("Start cook", systemImage: "play.circle") { starting = device }
                    }
                    Button("Rename", systemImage: "pencil") { renaming = device }
                    Button("Release", systemImage: "minus.circle", role: .destructive) { releasing = device }
                }
            }
        }
    }
}

/// One device: name, model and location, connection, and its active cook,
/// which `openCook` opens.
struct DeviceRow: View {
    let model: DevicesModel
    let device: Device
    let openCook: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(device.name)
                .font(.headline)
                .accessibilityIdentifier(AccessibilityID.deviceName(device.id))
            Text([device.model, device.location].compactMap { $0 }.joined(separator: " · "))
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Text(model.connectionText(for: device))
                .font(.subheadline)
                .foregroundStyle(device.connection?.state == .connected ? .green : .secondary)
                .accessibilityIdentifier(AccessibilityID.deviceConnection(device.id))
            if let cook = model.activeCook(for: device), let cooking = model.cookingText(for: device) {
                // Borderless, so a tap opens the cook rather than the row's
                // device detail.
                Button(cooking) { openCook(cook.id) }
                    .buttonStyle(.borderless)
                    .font(.subheadline)
                    .accessibilityIdentifier(AccessibilityID.deviceCooking(device.id))
            }
        }
        .padding(.vertical, 2)
    }
}

/// Every field of one device, with Start cook (or its active cook), Rename
/// and Release.
struct DeviceDetailView: View {
    let model: DevicesModel
    let cooks: CooksModel
    let deviceID: String
    @Binding var path: [Route]

    @Environment(\.dismiss) private var dismiss
    @State private var starting: Device?
    @State private var renaming: Device?
    @State private var releasing: Device?

    var body: some View {
        Group {
            if let device = model.device(id: deviceID) {
                List {
                    Section {
                        LabeledContent("Name", value: device.name)
                        LabeledContent("Device ID", value: device.id)
                        LabeledContent("Model", value: device.model)
                        LabeledContent("Location", value: device.location ?? "—")
                        LabeledContent("Status", value: model.connectionText(for: device))
                        LabeledContent("Cook", value: model.cookingText(for: device) ?? "Not cooking")
                        LabeledContent("Active", value: device.isActive ? "Yes" : "No")
                        LabeledContent("Claimed", value: Self.date(device.claimedAt))
                        LabeledContent("Last seen", value: Self.date(device.lastSeen))
                        if let firmware = device.firmware {
                            LabeledContent("Firmware", value: firmware.version)
                            LabeledContent("Firmware update", value: firmware.updateAvailable ? "Available" : "None")
                        }
                    }
                    if let configuration = device.configuration {
                        ConfigurationSection(configuration: configuration)
                    }
                    Section {
                        if let active = model.activeCook(for: device) {
                            Button("Open \(active.name)", systemImage: "list.bullet.rectangle") {
                                path.append(.cook(active.id))
                            }
                            .accessibilityIdentifier(AccessibilityID.detailOpenCook)
                        } else {
                            Button("Start cook", systemImage: "play.circle") { starting = device }
                                .accessibilityIdentifier(AccessibilityID.detailStartCook)
                        }
                        Button("Rename", systemImage: "pencil") { renaming = device }
                            .accessibilityIdentifier(AccessibilityID.detailRename)
                        Button("Release", systemImage: "minus.circle", role: .destructive) { releasing = device }
                            .accessibilityIdentifier(AccessibilityID.detailRelease)
                    }
                }
                .navigationTitle(device.name)
            } else {
                ContentUnavailableView("Device not found", systemImage: "questionmark.circle")
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        .sheet(item: $renaming) { device in
            RenameDeviceView(model: RenameDeviceModel(device: device, devices: model))
        }
        .startCookSheet(device: $starting, cooks: cooks, path: $path)
        .releaseConfirmation(model: model, device: $releasing) { dismiss() }
    }

    static func date(_ date: Date?) -> String {
        date?.formatted(date: .abbreviated, time: .shortened) ?? "—"
    }
}

/// A device's tunable settings.
private struct ConfigurationSection: View {
    let configuration: Components.Schemas.DeviceConfiguration

    var body: some View {
        Section("Configuration") {
            if let unit = configuration.temperatureUnit {
                LabeledContent("Temperature unit", value: unit == .celsius ? "Celsius" : "Fahrenheit")
            }
            if let interval = configuration.pollingInterval {
                LabeledContent("Polling interval", value: "\(interval) s")
            }
            correction("Grill probe correction", configuration.grillProbeCorrection)
            correction("Probe 1 correction", configuration.probe1Correction)
            correction("Probe 2 correction", configuration.probe2Correction)
            correction("Probe 3 correction", configuration.probe3Correction)
            correction("Probe 4 correction", configuration.probe4Correction)
            if let alerts = configuration.alertSettings {
                LabeledContent("High temperature alert", value: "\(alerts.highTempThreshold.formatted()) °F")
                LabeledContent("Low temperature alert", value: "\(alerts.lowTempThreshold.formatted()) °F")
                LabeledContent("Alert sounds", value: alerts.enableSounds ? "On" : "Off")
                LabeledContent("Push notifications", value: alerts.enablePushNotifications ? "On" : "Off")
            }
        }
    }

    @ViewBuilder
    private func correction(_ label: String, _ value: Double?) -> some View {
        if let value {
            LabeledContent(label, value: "\(value.formatted()) °F")
        }
    }
}

extension View {
    /// The start-cook form for `device`, as a sheet. Once the cook has
    /// started, or the form opens the device's active cook, the sheet closes
    /// and the cook's detail is pushed onto `path`.
    func startCookSheet(device: Binding<Device?>, cooks: CooksModel, path: Binding<[Route]>) -> some View {
        sheet(item: device) { shown in
            StartCookView(model: StartCookModel(device: shown, cooks: cooks)) { cookID in
                device.wrappedValue = nil
                path.wrappedValue.append(.cook(cookID))
            }
        }
    }

    /// Asks before releasing `device`, then releases it; says why when the
    /// API refuses. `onReleased` runs after a release or when the device
    /// turned out to be gone already.
    func releaseConfirmation(
        model: DevicesModel,
        device: Binding<Device?>,
        onReleased: @escaping () -> Void = {}
    ) -> some View {
        modifier(ReleaseConfirmation(model: model, device: device, onReleased: onReleased))
    }
}

private struct ReleaseConfirmation: ViewModifier {
    let model: DevicesModel
    @Binding var device: Device?
    let onReleased: () -> Void
    @State private var refused: (name: String, problem: APIProblem)?

    func body(content: Content) -> some View {
        content
            .confirmationDialog(
                "Release \(device?.name ?? "this device")?",
                isPresented: Binding(get: { device != nil }, set: { if !$0 { device = nil } }),
                titleVisibility: .visible,
                presenting: device
            ) { device in
                Button("Yes, release", role: .destructive) {
                    Task { await release(device) }
                }
                .accessibilityIdentifier(AccessibilityID.confirmRelease)
                Button("Cancel", role: .cancel) {}
            } message: { _ in
                Text("You'll need a new code from the device to claim it again.")
            }
            .alert(
                "Could not release \(refused?.name ?? "the device")",
                isPresented: Binding(get: { refused != nil }, set: { if !$0 { refused = nil } }),
                presenting: refused
            ) { _ in
                Button("OK") {}
            } message: { refused in
                Text(refused.problem.text)
            }
    }

    private func release(_ device: Device) async {
        switch await model.release(deviceID: device.id) {
        case .done, .deviceGone:
            onReleased()
        case .failed(let problem):
            refused = (device.name, problem)
        case .sessionEnded:
            break
        }
    }
}
