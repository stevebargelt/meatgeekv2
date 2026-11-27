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

    static func presentation(probes: [CookActivityPresentation.Probe]) -> CookActivityPresentation {
        CookActivityPresentation(
            cookName: "Brisket", startedAt: start, grill: "224° / 225°", probes: probes,
            url: CookLink.url(cookID: "cook-1")
        )
    }

    func render(_ presentation: CookActivityPresentation) -> CGImage? {
        let renderer = ImageRenderer(
            content: CookActivityLockScreenView(presentation: presentation).frame(width: 360)
        )
        renderer.scale = 2
        return renderer.cgImage
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
}
