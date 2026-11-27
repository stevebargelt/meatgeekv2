public import MeatGeekKit
public import SwiftUI

/// The cook on the lock screen: its name, the elapsed time ticking from its
/// start, the grill against its target, and each probe with a reading
/// against its target. Takes only the presentation value: what it shows is
/// decided by `CookActivityPresenter` (MeatGeekKit).
public struct CookActivityLockScreenView: View {
    public let presentation: CookActivityPresentation

    public init(presentation: CookActivityPresentation) {
        self.presentation = presentation
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Label(presentation.cookName, systemImage: "flame.fill")
                    .font(.headline)
                    .lineLimit(1)
                Spacer(minLength: 8)
                if let start = presentation.startedAt {
                    Text(timerInterval: start...Date.distantFuture, countsDown: false)
                        .font(.subheadline.monospacedDigit())
                        .multilineTextAlignment(.trailing)
                        .frame(maxWidth: 90, alignment: .trailing)
                }
            }
            HStack(alignment: .firstTextBaseline, spacing: 16) {
                CookActivityReadingView(label: "Grill", text: presentation.grill)
                ForEach(presentation.probes) { probe in
                    CookActivityReadingView(label: probe.label, text: probe.text)
                }
            }
        }
        .padding()
    }
}

/// One channel: its label over its text.
struct CookActivityReadingView: View {
    let label: String
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label)
                .font(.caption2)
                .foregroundStyle(.secondary)
            Text(text)
                .font(.callout.monospacedDigit().weight(.semibold))
                .lineLimit(1)
                .minimumScaleFactor(0.7)
        }
    }
}
