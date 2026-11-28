#if DEBUG
import MeatGeekKit
import SwiftUI

/// Debug builds only (#248): what a sender needs to reach this phone's
/// lock-screen activities by push, for the hand-sent trial pushes of
/// `apps/ios/scripts/live-activity-push.mjs`. Each token can be copied; none
/// is logged.
struct PushTokensView: View {
    let model: ActivityPushTokensModel

    var body: some View {
        NavigationStack {
            List {
                Section {
                    TokenRow(token: model.startToken, missing: "Not issued yet")
                } header: {
                    Text("Start an activity by push")
                } footer: {
                    Text("Send with: live-activity-push.mjs start --token <this>")
                }
                Section {
                    if model.activities.isEmpty {
                        Text("No lock-screen activity is running.")
                            .foregroundStyle(.secondary)
                    }
                    ForEach(model.activities) { activity in
                        VStack(alignment: .leading, spacing: 4) {
                            LabeledContent("Cook", value: activity.cookID)
                                .font(.caption)
                                .textSelection(.enabled)
                            TokenRow(
                                token: activity.updateToken,
                                missing: "No update token: only an activity started by push has one"
                            )
                            if let received = activity.updateTokenReceivedAt {
                                LabeledContent("Received", value: received.formatted(date: .omitted, time: .standard))
                                    .font(.caption)
                            }
                        }
                    }
                } header: {
                    Text("Running activities: update or end by push")
                } footer: {
                    Text("Send with: live-activity-push.mjs update|end --token <this>")
                }
                if let activeSince = model.activeSince {
                    Section {
                        LabeledContent("App active since", value: activeSince.formatted(date: .omitted, time: .standard))
                    } footer: {
                        Text("A token received before this came while the app was away.")
                    }
                }
            }
            .navigationTitle("Push tokens")
            .toolbar {
                Button("Refresh", systemImage: "arrow.clockwise") { model.refresh() }
            }
            .refreshable { model.refresh() }
        }
    }
}

private struct TokenRow: View {
    let token: String?
    let missing: String

    var body: some View {
        if let token {
            HStack {
                Text(token)
                    .font(.caption.monospaced())
                    .textSelection(.enabled)
                Spacer()
                Button("Copy", systemImage: "doc.on.doc") { UIPasteboard.general.string = token }
                    .labelStyle(.iconOnly)
                    .buttonStyle(.borderless)
            }
        } else {
            Text(missing).foregroundStyle(.secondary)
        }
    }
}
#endif
