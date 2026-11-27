import MeatGeekKit
import SwiftUI

/// An active cook's live readings: a badge (Live, Waiting, Reconnecting…,
/// No reading for …), Grill and Probes 1–4 with each one's target and a
/// reached probe's mark, and when the reading was taken.
/// Re-read every second, so the age and "No reading for …" advance without a
/// new message. Mirrors apps/web/src/live/live-panel.tsx.
struct LivePanelView: View {
    let model: LivePanelModel

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { _ in
            let display = model.display()
            Section {
                if display.showsSignedOutNote {
                    Text(LivePanelModel.signedOutNote)
                        .foregroundStyle(.red)
                        .accessibilityIdentifier(AccessibilityID.liveSignedOut)
                }
                if display.showsWaitingNote {
                    Text(LivePanelModel.waitingNote)
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier(AccessibilityID.liveWaiting)
                }
                ForEach(display.channels) { channel in
                    VStack(alignment: .leading, spacing: 2) {
                        LabeledContent(channel.label) {
                            Text(channel.text)
                                .monospacedDigit()
                                .accessibilityIdentifier(AccessibilityID.liveChannel(channel.id))
                        }
                        // The target beside the reading, and a reached
                        // probe's mark, on a line of their own so the
                        // reading reads as it did before targets.
                        if channel.target != nil || channel.reached != nil {
                            HStack(spacing: 8) {
                                Spacer()
                                if let reached = channel.reached {
                                    Text(reached)
                                        .foregroundStyle(.green)
                                        .accessibilityIdentifier(AccessibilityID.liveReached(channel.id))
                                }
                                if let target = channel.target {
                                    Text(target)
                                        .foregroundStyle(.secondary)
                                        .accessibilityIdentifier(AccessibilityID.liveTarget(channel.id))
                                }
                            }
                            .font(.caption)
                            .monospacedDigit()
                        }
                    }
                }
                Text(display.readingTime)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier(AccessibilityID.liveReadingTime)
            } header: {
                HStack {
                    Text("Live readings")
                    Spacer()
                    LiveBadge(state: display.state, text: display.badge)
                }
            }
        }
    }
}

/// The panel's state as a coloured capsule.
struct LiveBadge: View {
    let state: LivePanelState
    let text: String

    var body: some View {
        Text(text)
            .font(.caption.weight(.semibold))
            .textCase(nil)
            .padding(.horizontal, 8)
            .padding(.vertical, 2)
            .foregroundStyle(.white)
            .background(color, in: Capsule())
            .accessibilityIdentifier(AccessibilityID.liveBadge)
            .accessibilityValue(state.rawValue)
    }

    private var color: Color {
        switch state {
        case .live: .green
        case .waiting, .connecting: .gray
        case .stale: .orange
        }
    }
}

/// UI test mode only, in the cook screen's navigation bar: the stub hub's
/// hooks, so a UI test can drop the connection, let it reconnect, move the
/// clock on, and stop the cook from "another client".
struct LiveTestMenu: View {
    let controls: StubLive
    let cookID: String

    var body: some View {
        Menu("UI test", systemImage: "ladybug") {
            Button("Drop connection") { controls.dropConnection() }
                .accessibilityIdentifier(AccessibilityID.liveTestDrop)
            Button("Reconnect now") { controls.reconnectNow() }
                .accessibilityIdentifier(AccessibilityID.liveTestReconnect)
            Button("Advance clock 3 min") { controls.advanceClock(by: 180) }
                .accessibilityIdentifier(AccessibilityID.liveTestAdvanceClock)
            Button("Send cook_stopped") { Task { await controls.sendCookStopped(cookID: cookID) } }
                .accessibilityIdentifier(AccessibilityID.liveTestCookStopped)
        }
        .accessibilityIdentifier(AccessibilityID.liveTestMenu)
    }
}
