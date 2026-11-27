import Foundation
import MeatGeekActivity
import MeatGeekKit
import SwiftUI
import Testing

/// The lock-screen view, drawn from its presentation value alone (#271).
/// What it shows is tested in MeatGeekKitTests (`CookActivityTests`); this
/// proves the view renders from that value, on CI's simulator, unsigned.
@Suite("Lock-screen activity views")
@MainActor
struct CookActivityViewTests {
    static let start = Date(timeIntervalSince1970: 1_795_370_400)

    static let island = CookActivityPresentation.Island(label: "Probe 1", shortLabel: "P1", text: "187° → 203°")

    static func presentation(
        probes: [CookActivityPresentation.Probe],
        island: CookActivityPresentation.Island = island,
        status: CookActivityPresentation.Status = .current
    ) -> CookActivityPresentation {
        CookActivityPresentation(
            cookName: "Brisket", startedAt: status == .ended ? nil : start, grill: "224° / 225°", probes: probes,
            island: island, islandTrailing: status == .ended ? "Ended" : status.note ?? island.text,
            islandMinimal: status == .ended ? "Ended" : "187°", status: status, url: CookLink.url(cookID: "cook-1")
        )
    }

    func render(_ presentation: CookActivityPresentation) -> CGImage? {
        render(CookActivityLockScreenView(presentation: presentation), width: 360)
    }

    func render(_ view: some View, width: CGFloat) -> CGImage? {
        let renderer = ImageRenderer(content: view.frame(width: width))
        renderer.scale = 2
        return renderer.cgImage
    }

    /// Every view of the activity, each at a width it gets on a phone.
    func renderAll(_ presentation: CookActivityPresentation) throws {
        let views: [(AnyView, CGFloat)] = [
            (AnyView(CookActivityLockScreenView(presentation: presentation)), 360),
            (AnyView(CookActivityIslandExpandedView(presentation: presentation)), 340),
            (AnyView(CookActivityIslandLeadingView(presentation: presentation)), 60),
            (AnyView(CookActivityIslandTrailingView(presentation: presentation)), 80),
            (AnyView(CookActivityIslandMinimalView(presentation: presentation)), 36),
        ]
        for (view, width) in views {
            let image = try #require(render(view, width: width))
            #expect(image.width == Int(width * 2))
            #expect(image.height > 0)
        }
    }

    @Test("renders the cook with the grill and every probe that has a reading")
    func rendersWithProbes() throws {
        let image = try #require(render(Self.presentation(probes: [
            .init(label: "Probe 1", text: "187° → 203°"),
            .init(label: "Probe 2", text: "150°"),
        ])))
        #expect(image.width == 720)
        #expect(image.height > 0)
    }

    @Test("renders the grill alone when no probe has a reading")
    func rendersGrillOnly() throws {
        let image = try #require(render(Self.presentation(probes: [])))
        #expect(image.width == 720)
        #expect(image.height > 0)
    }

    @Test("renders a reached probe and every Dynamic Island view (#272)")
    func rendersReachedAndIsland() throws {
        try renderAll(Self.presentation(
            probes: [.init(label: "Probe 1", text: "204° · 203° ✓ 3:42\u{202F}PM"), .init(label: "Probe 2", text: "150° → 165°")],
            island: .init(label: "Probe 2", shortLabel: "P2", text: "150° → 165°")
        ))
        try renderAll(Self.presentation(probes: [], island: .init(label: "Grill", shortLabel: "Grill", text: "224° / 225°")))
        try renderAll(Self.presentation(
            probes: [.init(label: "Probe 1", text: "204° · 203° ✓ 3:42\u{202F}PM")],
            island: .init(label: "Probe 1", shortLabel: "P1", text: "204° ✓")
        ))
    }

    @Test("renders the stale state: \"as of\" the last update's time")
    func rendersStale() throws {
        try renderAll(Self.presentation(
            probes: [.init(label: "Probe 1", text: "187° → 203°")], status: .stale(asOf: "3:42\u{202F}PM")
        ))
    }

    @Test("renders the ended state: \"Cook ended\" with the last temperatures")
    func rendersEnded() throws {
        try renderAll(Self.presentation(probes: [.init(label: "Probe 1", text: "204° → 203°")], status: .ended))
    }
}
