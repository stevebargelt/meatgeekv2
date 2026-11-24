import MeatGeekAPI
import MeatGeekKit
import SwiftUI

/// A screen a tab's navigation stack can push.
enum Route: Hashable {
    case device(String)
    case cook(String)
}

extension View {
    /// The screens either tab can push: a device's detail and a cook's detail.
    func routes(devices: DevicesModel, cooks: CooksModel, path: Binding<[Route]>) -> some View {
        navigationDestination(for: Route.self) { route in
            switch route {
            case .device(let id):
                DeviceDetailView(model: devices, cooks: cooks, deviceID: id, path: path)
            case .cook(let id):
                CookDetailView(model: CookDetailModel(cookID: id, cooks: cooks))
            }
        }
    }
}

/// The Cooks tab: newest first, "Load more", device and status filters,
/// pull to refresh. Tapping a cook opens its detail.
struct CooksView: View {
    let model: CooksModel
    let profile: ProfileModel
    let session: SessionModel

    @State private var path: [Route] = []

    var body: some View {
        NavigationStack(path: $path) {
            List {
                content
            }
            .navigationTitle("Cooks")
            .routes(devices: model.devices, cooks: model, path: $path)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    AccountMenu(profile: profile, session: session)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    CookFilterMenu(model: model)
                }
            }
            .refreshable { await model.refresh() }
            .task { await model.start() }
            // For the device names and the filter's choices.
            .task { await model.devices.start() }
        }
    }

    @ViewBuilder
    private var content: some View {
        if model.isFiltered {
            Section {
                HStack {
                    Text(filterSummary)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier(AccessibilityID.cooksFilterSummary)
                    Spacer()
                    Button("Clear") { Task { await model.clearFilters() } }
                    .buttonStyle(.borderless)
                    .accessibilityIdentifier(AccessibilityID.cooksClearFilters)
                }
            }
        }
        switch model.list {
        case .loading:
            ProgressView("Loading cooks…")
                .frame(maxWidth: .infinity)
                .accessibilityIdentifier(AccessibilityID.cooksLoading)
        case .failed(let problem):
            VStack(alignment: .leading, spacing: 12) {
                ProblemText(problem: problem)
                    .accessibilityIdentifier(AccessibilityID.cooksError)
                Button("Try again") { Task { await model.refresh() } }
            }
        case .loaded(let cooks, _, _) where cooks.isEmpty:
            Text(model.emptyText)
                .foregroundStyle(.secondary)
                .accessibilityIdentifier(AccessibilityID.cooksEmpty)
        case .loaded(let cooks, _, let hasMore):
            Section {
                ForEach(cooks) { cook in
                    NavigationLink(value: Route.cook(cook.id)) {
                        CookRow(cook: cook, deviceName: model.deviceName(for: cook.deviceId))
                    }
                    .accessibilityIdentifier(AccessibilityID.cookRow(cook.id))
                }
            }
            if model.moreProblem != nil || hasMore {
                Section {
                    if let problem = model.moreProblem {
                        ProblemText(problem: problem)
                            .accessibilityIdentifier(AccessibilityID.cooksMoreProblem)
                    }
                    if hasMore {
                        Button(model.loadingMore ? "Loading…" : "Load more") {
                            Task { await model.loadMore() }
                        }
                        .disabled(model.loadingMore)
                        .frame(maxWidth: .infinity)
                        .accessibilityIdentifier(AccessibilityID.cooksLoadMore)
                    }
                }
            }
        }
    }

    private var filterSummary: String {
        var parts: [String] = []
        if let deviceID = model.deviceFilter { parts.append(model.deviceName(for: deviceID)) }
        if let status = model.statusFilter { parts.append(CookText.status(status)) }
        return "Showing: " + parts.joined(separator: " · ")
    }
}

/// The device and status filters, in a toolbar menu.
struct CookFilterMenu: View {
    let model: CooksModel

    var body: some View {
        Menu {
            Picker("Device", selection: Binding(
                get: { model.deviceFilter },
                set: { deviceID in Task { await model.setDeviceFilter(deviceID) } }
            )) {
                Text("All devices").tag(String?.none)
                ForEach(model.deviceOptions) { option in
                    Text(option.name).tag(Optional(option.id))
                }
            }
            .pickerStyle(.menu)
            Picker("Status", selection: Binding(
                get: { model.statusFilter },
                set: { status in Task { await model.setStatusFilter(status) } }
            )) {
                Text("All").tag(Components.Schemas.CookStatus?.none)
                ForEach(CooksModel.statusFilters, id: \.self) { status in
                    Text(CookText.status(status)).tag(Optional(status))
                }
            }
            .pickerStyle(.menu)
        } label: {
            Label(
                "Filter",
                systemImage: model.isFiltered
                    ? "line.3.horizontal.decrease.circle.fill" : "line.3.horizontal.decrease.circle"
            )
        }
        .accessibilityIdentifier(AccessibilityID.cooksFilter)
    }
}

/// One cook: name, device, status and start time.
struct CookRow: View {
    let cook: Cook
    let deviceName: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(cook.name)
                .font(.headline)
                .accessibilityIdentifier(AccessibilityID.cookName(cook.id))
            Text(deviceName)
                .font(.subheadline)
                .foregroundStyle(.secondary)
            HStack(spacing: 6) {
                Text(CookText.status(cook.status))
                    .foregroundStyle(cook.status == .active ? .green : .secondary)
                    .accessibilityIdentifier(AccessibilityID.cookStatus(cook.id))
                Text("·").foregroundStyle(.secondary)
                Text(CookText.dateTime(cook.startTime))
                    .foregroundStyle(.secondary)
            }
            .font(.subheadline)
        }
        .padding(.vertical, 2)
    }
}

/// One cook's fields, Stop and the live readings while it is active, and the
/// space the chart will take.
struct CookDetailView: View {
    @State var model: CookDetailModel
    @State private var confirmingStop = false
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        Group {
            switch model.state {
            case .loading:
                ProgressView("Loading cook…")
                    .accessibilityIdentifier(AccessibilityID.cookDetailLoading)
            case .notFound:
                ContentUnavailableView {
                    Label(CookDetailModel.notFoundMessage, systemImage: "questionmark.circle")
                        .accessibilityIdentifier(AccessibilityID.cookDetailNotFound)
                } description: {
                    Text("Go back to your cooks.")
                }
            case .failed(let problem):
                VStack(spacing: 12) {
                    ProblemText(problem: problem)
                        .accessibilityIdentifier(AccessibilityID.cookDetailError)
                    Button("Try again") { Task { await model.reload() } }
                }
                .padding()
            case .loaded(let cook):
                fields(cook)
            }
        }
        .navigationTitle(model.cook?.name ?? "Cook")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let live = model.live, let controls = live.testControls {
                ToolbarItem(placement: .topBarTrailing) {
                    LiveTestMenu(controls: controls, cookID: live.cookID)
                }
            }
        }
        .task { await model.start() }
        // The live panel connects while this screen shows and the app is in
        // the foreground; a trip to the background closes it.
        .onAppear { model.appear() }
        .onDisappear { model.disappear() }
        .onChange(of: scenePhase, initial: true) { _, phase in model.setAppActive(phase == .active) }
        .confirmationDialog(
            CookDetailModel.stopConfirmTitle(name: model.cook?.name ?? "this cook"),
            isPresented: $confirmingStop,
            titleVisibility: .visible
        ) {
            Button("Yes, stop cook", role: .destructive) {
                Task { await model.stop() }
            }
            .accessibilityIdentifier(AccessibilityID.confirmStop)
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(CookDetailModel.stopConfirmMessage)
        }
    }

    private func fields(_ cook: Cook) -> some View {
        List {
            // The live readings first: while a cook runs they are what the
            // screen is for.
            if cook.status == .active, let live = model.live {
                LivePanelView(model: live)
            }

            Section {
                LabeledContent("Status") {
                    Text(CookText.status(cook.status))
                        .accessibilityIdentifier(AccessibilityID.cookDetailStatus)
                }
                LabeledContent("Meat type", value: cook.meatType ?? "—")
                LabeledContent("Device", value: model.deviceName(for: cook))
                LabeledContent("Started", value: CookText.dateTime(cook.startTime))
                if let end = cook.endTime {
                    LabeledContent("Ended") {
                        Text(CookText.dateTime(end))
                            .accessibilityIdentifier(AccessibilityID.cookDetailEnded)
                    }
                } else if cook.status == .active {
                    TimelineView(.periodic(from: .now, by: 1)) { _ in
                        LabeledContent("Elapsed", value: model.elapsedText(for: cook))
                    }
                }
                LabeledContent("Weight", value: cook.weight.map(CookText.weight) ?? "—")
                let targets = model.targets(of: cook)
                if targets.isEmpty {
                    LabeledContent("Targets", value: "—")
                } else {
                    ForEach(targets, id: \.key) { target in
                        LabeledContent(target.key.label, value: target.text)
                    }
                }
                LabeledContent("Notes", value: cook.notes ?? "—")
            }

            if cook.status == .active {
                stopSection
            }

            // Placeholder, on purpose: the chart (the next issue) goes here.
            Section("Chart") {
                Text("The cook's chart will show here.")
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier(AccessibilityID.cookDetailChartPlaceholder)
            }
        }
        .refreshable { await model.reload() }
    }

    @ViewBuilder
    private var stopSection: some View {
        Section {
            switch model.stopState {
            case .twinFailed(let problem):
                Text(CookDetailModel.stopTwinFailedMessage)
                ProblemText(problem: problem)
                    .accessibilityIdentifier(AccessibilityID.cookDetailStopProblem)
                Button("Retry") { Task { await model.stop() } }
            case .failed(let problem):
                ProblemText(problem: problem)
                    .accessibilityIdentifier(AccessibilityID.cookDetailStopProblem)
                stopButton
            case .idle, .stopping:
                stopButton
            }
        }
    }

    private var stopButton: some View {
        Button(model.stopState == .stopping ? "Stopping…" : "Stop cook", systemImage: "stop.circle", role: .destructive) {
            confirmingStop = true
        }
        .disabled(model.stopState == .stopping)
        .accessibilityIdentifier(AccessibilityID.cookDetailStop)
    }
}

/// Start a cook on one device. A sheet; `onOpen` closes it and opens a cook:
/// the new one, or the device's active cook after a 409.
struct StartCookView: View {
    @State var model: StartCookModel
    let onOpen: (String) -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Name", text: $model.input.name)
                        .accessibilityIdentifier(AccessibilityID.startName)
                    FieldError(message: model.fieldErrors.name)
                    TextField("Meat type", text: $model.input.meatType)
                        .accessibilityIdentifier(AccessibilityID.startMeatType)
                    FieldError(message: model.fieldErrors.meatType)
                    TextField("Weight (lb, optional)", text: $model.input.weight)
                        .keyboardType(.decimalPad)
                        .accessibilityIdentifier(AccessibilityID.startWeight)
                    FieldError(message: model.fieldErrors.weight)
                } header: {
                    Text("On \(model.deviceName)")
                }
                Section("Targets (°F, optional)") {
                    ForEach(TargetKey.allCases, id: \.self) { key in
                        TextField(key.label, text: Binding(
                            get: { model.input[target: key] },
                            set: { model.input[target: key] = $0 }
                        ))
                        .keyboardType(.decimalPad)
                        .accessibilityIdentifier(AccessibilityID.startTarget(key.rawValue))
                        FieldError(message: model.fieldErrors.targets[key])
                    }
                }
                if let outcome = model.outcome {
                    outcomeSection(outcome)
                }
            }
            .navigationTitle("Start a cook")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .accessibilityIdentifier(AccessibilityID.startCancel)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(model.sending ? "Starting…" : "Start") {
                        Task {
                            if let cook = await model.submit() { onOpen(cook.id) }
                        }
                    }
                    .disabled(model.sending)
                    .accessibilityIdentifier(AccessibilityID.startSubmit)
                }
            }
            .interactiveDismissDisabled(model.sending)
        }
    }

    @ViewBuilder
    private func outcomeSection(_ outcome: StartCookModel.Outcome) -> some View {
        Section {
            switch outcome {
            case .problem(let problem):
                ProblemText(problem: problem)
                    .accessibilityIdentifier(AccessibilityID.startProblem)
            case .alreadyActive(let activeCookID, _):
                Text(StartCookModel.alreadyActiveMessage)
                    .foregroundStyle(.red)
                    .accessibilityIdentifier(AccessibilityID.startProblem)
                Button("Open the active cook") { onOpen(activeCookID) }
                    .accessibilityIdentifier(AccessibilityID.startOpenActive)
            case .twinFailed(let cookID, let problem):
                Text(StartCookModel.twinFailedMessage)
                    .accessibilityIdentifier(AccessibilityID.startProblem)
                ProblemText(problem: problem)
                Button(model.sending ? "Retrying…" : "Retry") {
                    Task {
                        if let cook = await model.retry() { onOpen(cook.id) }
                    }
                }
                .disabled(model.sending)
                Button("Open the cook") { onOpen(cookID) }
            }
        }
    }
}
