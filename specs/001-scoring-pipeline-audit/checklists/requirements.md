# Specification Quality Checklist: Scoring Pipeline Audit & Silent-Rejection Fix

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-05-12
**Feature**: [spec.md](../spec.md)

## Content Quality

- [ ] CHK001 No implementation details (languages, frameworks, APIs) leaked into user-facing requirements
- [ ] CHK002 Focus is on user value and business outcomes, not technical mechanism
- [ ] CHK003 Written for non-technical stakeholders (the bot owner, not the engineer)
- [ ] CHK004 All mandatory sections completed (User Scenarios, Requirements, Success Criteria, Assumptions)

## Requirement Completeness

- [ ] CHK005 No `[NEEDS CLARIFICATION]` markers remain (current count: 0)
- [ ] CHK006 Requirements are testable and unambiguous
- [ ] CHK007 Success criteria are measurable (zero variance, ≥80%, etc.) and time-bound where applicable
- [ ] CHK008 Success criteria are technology-agnostic (no mention of "TypeScript", "Sonnet", etc. in SC-NNN lines)
- [ ] CHK009 All seven in-scope culprits map to at least one User Story (US-1: #2+#6, US-2: #5+#7, US-3: #4, US-4: #3, US-5: #6, US-6: #5, US-7: #8)
- [ ] CHK010 Each user story has at least 2 acceptance scenarios in Given/When/Then form
- [ ] CHK011 Each user story can be tested independently of the others (verified per template)
- [ ] CHK012 User stories prioritized (P1/P2/P3) with rationale
- [ ] CHK013 Edge cases identified for each major behaviour change
- [ ] CHK014 Scope boundary is explicit — culprit #1 (kill-zone) called out as OUT OF SCOPE

## Feature Readiness

- [ ] CHK015 All functional requirements (FR-001 through FR-019) trace back to a user story
- [ ] CHK016 User stories collectively deliver the parent goal: "stop losing winning trades to silent rejections"
- [ ] CHK017 No requirement depends on a feature in a later iteration without an interim fallback
- [ ] CHK018 P1 stories form a viable MVP — shipping just US-1 + US-2 + US-3 already meaningfully reduces silent rejections
- [ ] CHK019 Backward compatibility addressed (FR-017 default `max_total_risk_pct=0` preserves current behaviour)
- [ ] CHK020 Backtest gates exist before behaviour changes (US-4 gated on FR-011 backtest)

## Risk & Safety

- [ ] CHK021 Cooldown rule (US-3) cannot be bypassed by analyst APPROVE — code-level wins
- [ ] CHK022 Risk-budget composition with existing analyst CHECK 4 explicitly handled (FR-019)
- [ ] CHK023 Fail-OPEN behaviour defined for missing data (structure scorer in Edge Cases)
- [ ] CHK024 No regression risk in existing 820 tests (Assumptions section)
- [ ] CHK025 Load-bearing 1.30R/1.31R desync is explicitly preserved (Assumptions section)

## Notes

- Check items off as completed: `[x]`
- Any unchecked item after spec review must be either resolved in spec.md OR documented as a deferred decision
- This checklist is the gate to `/speckit-plan` — do not proceed to planning until ≥CHK005, CHK006, CHK008, CHK009, CHK014, CHK015, CHK018 are checked
