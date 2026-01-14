# Tasks: Entity Impact Graph (力导向图可视化)

## Task Progress

### Phase 1: Foundation (Parallel)
- [x] **IMPL-001**: Extend ECharts wrapper for graph series support → [📋](./.task/IMPL-001.json) [✅](./.summaries/IMPL-001-summary.md)
- [x] **IMPL-002**: Create GraphQL types for entity objects with type/confidence → [📋](./.task/IMPL-002.json) [✅](./.summaries/IMPL-002-summary.md)

### Phase 2: Backend API (Sequential)
- [ ] **IMPL-003**: Create correlation service for entity-financial relationships → [📋](./.task/IMPL-003.json)
- [ ] **IMPL-004**: Create GraphQL resolver for entity impact graph data → [📋](./.task/IMPL-004.json)

### Phase 3: Frontend Data Layer
- [ ] **IMPL-005**: Create useEntityImpactGraph data hook → [📋](./.task/IMPL-005.json)

### Phase 4: UI Component (Sequential)
- [ ] **IMPL-006**: Create EntityImpactGraph React component → [📋](./.task/IMPL-006.json)
- [ ] **IMPL-007**: Integrate EntityImpactGraph component into dashboard layout → [📋](./.task/IMPL-007.json)

### Phase 5: Polish
- [ ] **IMPL-008**: Add interaction features (tooltips, click events, filtering) → [📋](./.task/IMPL-008.json)

## Dependency Graph

```
IMPL-001 (ECharts) ─────────────────────┐
                                        ├──> IMPL-005 (Hook) ──> IMPL-006 (Component) ──> IMPL-007 (Integration) ──> IMPL-008 (Interactions)
IMPL-002 (Types) ──> IMPL-003 (Service) ──> IMPL-004 (Resolver) ─┘
```

## Execution Summary

| Phase | Tasks | Parallelizable | Dependencies |
|-------|-------|----------------|--------------|
| 1 | IMPL-001, IMPL-002 | Yes | None |
| 2 | IMPL-003, IMPL-004 | No | IMPL-002 |
| 3 | IMPL-005 | No | IMPL-001, IMPL-004 |
| 4 | IMPL-006, IMPL-007 | No | IMPL-005, IMPL-006 |
| 5 | IMPL-008 | No | IMPL-007 |

## Status Legend

- `- [ ]` = Pending task
- `- [x]` = Completed task
- `📋` = Task JSON specification
- `✅` = Task summary (after completion)

## Quick Links

- [Implementation Plan](./IMPL_PLAN.md)
- [Context Package](./.process/context-package.json)
- [Session Metadata](./workflow-session.json)
