---
id: MG-13
type: story
status: active
title: "[Phase 3+] pact-consumer-driven-contracts"
---

#### Context
#2 chose Schemathesis (property-based fuzz against the OpenAPI spec) for current contract testing because Pact requires consumer participation and no consumers exist yet. Add Pact when real consumer code exists (React Native in Phase 3, React web sometime after).

#### Acceptance Criteria
- [ ] Pact consumer-side setup in `apps/mobile` (and `apps/web` if it's consuming the API by then)
- [ ] Pact provider-side verification in `apps/api`
- [ ] Pact broker hosting decision (PactFlow free tier vs. self-host)
- [ ] CI runs both Schemathesis and Pact verification — they're complementary, not exclusive (Schemathesis = spec vs impl; Pact = impl vs consumer expectations)

#### Notes
Schemathesis stays — Pact layers on top, doesn't replace.