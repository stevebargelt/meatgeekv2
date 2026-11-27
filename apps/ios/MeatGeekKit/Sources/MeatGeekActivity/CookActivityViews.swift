public import MeatGeekKit
public import SwiftUI

/// The cook on the lock screen: its name, the elapsed time ticking from its
/// start, the grill against its target, each probe with a reading against
/// its target (a reached one with the mark and the time), and "as of 3:42"
/// or "Cook ended" when it is stale or over. Takes only the presentation
/// value: what it shows is decided by `CookActivityPresenter` (MeatGeekKit).
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
                CookActivityTimeView(presentation: presentation)
            }
            CookActivityReadingsView(presentation: presentation)
        }
        .padding()
    }
}

/// The ticking elapsed time, or the status note ("as of 3:42", "Cook
/// ended") in its place when there is one.
struct CookActivityTimeView: View {
    let presentation: CookActivityPresentation

    var body: some View {
        if let note = presentation.status.note {
            Text(note)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(presentation.status == .ended ? .primary : .secondary)
                .lineLimit(1)
        } else if let start = presentation.startedAt {
            Text(timerInterval: start...Date.distantFuture, countsDown: false)
                .font(.subheadline.monospacedDigit())
                .multilineTextAlignment(.trailing)
                .frame(maxWidth: 90, alignment: .trailing)
        }
    }
}

/// The grill and each probe with a reading.
struct CookActivityReadingsView: View {
    let presentation: CookActivityPresentation

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 16) {
            CookActivityReadingView(label: "Grill", text: presentation.grill)
            ForEach(presentation.probes) { probe in
                CookActivityReadingView(label: probe.label, text: probe.text)
            }
        }
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

/// The Dynamic Island's compact leading side: the island channel's short
/// label ("P1", "Grill").
public struct CookActivityIslandLeadingView: View {
    public let presentation: CookActivityPresentation

    public init(presentation: CookActivityPresentation) {
        self.presentation = presentation
    }

    public var body: some View {
        Label(presentation.island.shortLabel, systemImage: "flame.fill")
            .font(.caption.weight(.semibold))
            .labelStyle(.titleAndIcon)
            .lineLimit(1)
    }
}

/// The Dynamic Island's compact trailing side: the island channel's text
/// ("187° → 203°", "204° ✓"), or the status note when stale or ended.
public struct CookActivityIslandTrailingView: View {
    public let presentation: CookActivityPresentation

    public init(presentation: CookActivityPresentation) {
        self.presentation = presentation
    }

    public var body: some View {
        Text(presentation.status == .ended ? "Ended" : presentation.island.text)
            .font(.caption.monospacedDigit().weight(.semibold))
            .foregroundStyle(presentation.status == .current ? .primary : .secondary)
            .lineLimit(1)
            .minimumScaleFactor(0.7)
    }
}

/// The Dynamic Island's minimal presentation: the island channel's text alone.
public struct CookActivityIslandMinimalView: View {
    public let presentation: CookActivityPresentation

    public init(presentation: CookActivityPresentation) {
        self.presentation = presentation
    }

    public var body: some View {
        Text(presentation.status == .ended ? "✓" : presentation.island.text.components(separatedBy: " ").first ?? "")
            .font(.caption2.monospacedDigit().weight(.semibold))
            .lineLimit(1)
            .minimumScaleFactor(0.5)
    }
}

/// The expanded Dynamic Island: the cook and its time over every reading.
public struct CookActivityIslandExpandedView: View {
    public let presentation: CookActivityPresentation

    public init(presentation: CookActivityPresentation) {
        self.presentation = presentation
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(presentation.cookName)
                    .font(.headline)
                    .lineLimit(1)
                Spacer(minLength: 8)
                CookActivityTimeView(presentation: presentation)
            }
            CookActivityReadingsView(presentation: presentation)
        }
    }
}
