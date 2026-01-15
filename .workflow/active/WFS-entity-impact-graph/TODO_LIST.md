# Tasks: Entity Impact Graph (力导向图可视化)

## Task Progress

### Phase 1: Foundation (Parallel)
- [x] **IMPL-001**: Extend ECharts wrapper for graph series support → [📋](./.task/IMPL-001.json) [✅](./.summaries/IMPL-001-summary.md)
- [x] **IMPL-002**: Create GraphQL types for entity objects with type/confidence → [📋](./.task/IMPL-002.json) [✅](./.summaries/IMPL-002-summary.md)

### Phase 2: Backend API (Sequential)
- [x] **IMPL-003**: Create correlation service for entity-financial relationships → [📋](./.task/IMPL-003.json) [✅](./.summaries/IMPL-003-summary.md)
- [x] **IMPL-004**: Create GraphQL resolver for entity impact graph data → [📋](./.task/IMPL-004.json) [✅](./.summaries/IMPL-004-summary.md)

### Phase 3: Frontend Data Layer
- [x] **IMPL-005**: Create useEntityImpactGraph data hook → [📋](./.task/IMPL-005.json) [✅](./.summaries/IMPL-005-summary.md)

### Phase 4: UI Component (Sequential)
- [x] **IMPL-006**: Create EntityImpactGraph React component → [📋](./.task/IMPL-006.json) [✅](./.summaries/IMPL-006-summary.md)
- [x] **IMPL-007**: Integrate EntityImpactGraph component into dashboard layout → [📋](./.task/IMPL-007.json) [✅](./.summaries/IMPL-007-summary.md)

### Phase 5: Polish
- [x] **IMPL-008**: Add interaction features (tooltips, click events, filtering) → [📋](./.task/IMPL-008.json) [✅](./.summaries/IMPL-008-summary.md)

### Phase 6: Real Implementation + Admin Configuration (Next Iteration)
- [ ] **IMPL-009**: Backend - Use authenticated org context + fix input semantics (confidence vs correlation) → [📋](./.task/IMPL-009.json)
- [ ] **IMPL-010**: Backend - Persist EntityImpactGraph settings (per-org) + GraphQL query/mutation → [📋](./.task/IMPL-010.json)
- [ ] **IMPL-011**: Frontend - Admin panel (System Settings tab) to edit EntityImpactGraph settings → [📋](./.task/IMPL-011.json)
- [ ] **IMPL-012**: Frontend - Apply server-configured defaults to dashboard graph query + UI → [📋](./.task/IMPL-012.json)
- [ ] **IMPL-013**: Backend - Performance & caching for graph generation (Mongo aggregation + cache keys) → [📋](./.task/IMPL-013.json)

## Dependency Graph

```
IMPL-001 (ECharts) ─────────────────────┐
                                        ├──> IMPL-005 (Hook) ──> IMPL-006 (Component) ──> IMPL-007 (Integration) ──> IMPL-008 (Interactions)
IMPL-002 (Types) ──> IMPL-003 (Service) ──> IMPL-004 (Resolver) ─┘

IMPL-004 (Resolver) ──> IMPL-009 (Real org + inputs) ──> IMPL-010 (Settings API) ──> IMPL-011 (Admin UI) ──> IMPL-012 (Apply defaults)
                                     └───────────────────────────────────────────────> IMPL-013 (Perf + cache)
```

## Execution Summary

| Phase | Tasks | Parallelizable | Dependencies |
|-------|-------|----------------|--------------|
| 1 | IMPL-001, IMPL-002 | Yes | None |
| 2 | IMPL-003, IMPL-004 | No | IMPL-002 |
| 3 | IMPL-005 | No | IMPL-001, IMPL-004 |
| 4 | IMPL-006, IMPL-007 | No | IMPL-005, IMPL-006 |
| 5 | IMPL-008 | No | IMPL-007 |
| 6 | IMPL-009 to IMPL-013 | Mixed | IMPL-004 |

## Status Legend

- `- [ ]` = Pending task
- `- [x]` = Completed task
- `📋` = Task JSON specification
- `✅` = Task summary (after completion)

## Quick Links

- [Implementation Plan](./IMPL_PLAN.md)
- [Context Package](./.process/context-package.json)
- [Session Metadata](./workflow-session.json)
