---
id: MG-9
type: story
status: done
title: data-models-impl-fixes
closed: 2026-07-21
closed_commit: 0ebf184
---

#### Context
Bugs in `libs/data-models` that the #3 test suite pins as characterization tests with `// BUG:` comments. Each represents a real divergence that should be resolved (probably by aligning cook-manager and DataValidator on a single source of truth, likely the constants in `@meatgeekv2/utils`).

#### Acceptance Criteria
- [ ] `createCook` cookId generation collision risk addressed (Date.now()+Math.random with 9-char base36 ≈ 34 bits entropy is insufficient for distributed concurrent creates — UUIDv4 or ULID recommended)
- [ ] `calculateRSquared` NaN propagation when all `normalizedTimes` are identical (denominator becomes zero in slope calc, line ~260 of temperature-calculator.ts)
- [ ] Hardcoded anomaly thresholds (15/25/50°F in `detectAnomalies`) either documented with rationale or made configurable
- [ ] cook-manager vs DataValidator divergence on `meatType` lookup: cook-manager uses object KEY (PORK_SHOULDER), DataValidator uses `.name` field (Pork Shoulder). Unify on one strategy.
- [ ] cook name trim/no-trim disagreement between cook-manager and DataValidator
- [ ] Weight bounds disagreement: cook-manager hard-fails outside 0<w≤100, DataValidator allows >0 with warning over 50. Unify.
- [ ] `validateCookNameUniqueness` compares `cook.name !== excludeCookId` — almost certainly meant `cook.id !== excludeCookId`. Fix and verify existing characterization test for the old behavior is updated.
- [ ] Update the corresponding `// BUG:` characterization tests in #3's spec files to assert the fixed behavior