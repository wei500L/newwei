---
identifier: WFS-entity-impact-graph
source: "User requirements: Entity Impact Graph visualization"
analysis: .workflow/active/WFS-entity-impact-graph/.process/context-package.json
artifacts: .workflow/active/WFS-entity-impact-graph/.brainstorming/
context_package: .workflow/active/WFS-entity-impact-graph/.process/context-package.json
workflow_type: "standard"
verification_history:
  concept_verify: "passed"
  action_plan_verify: "pending"
phase_progression: "context → exploration → user-decisions → planning"
---

# Implementation Plan: Entity Impact Graph (力导向图可视化)

## 1. Summary

This implementation plan details the creation of an interactive Entity Impact Graph - a force-directed visualization showing relationships between news entities (people, organizations) and financial instruments (stocks, commodities). The graph will enable users to intuitively understand how entities propagate influence through sectors to affect prices.

**Core Objectives**:
- Create force-directed graph visualization using ECharts graph series
- Implement hybrid correlation approach combining co-occurrence frequency with correlation strength
- Expose full entity objects with type/confidence through extended GraphQL schema
- Integrate seamlessly into existing dashboard layout as new row below current charts

**Technical Approach**:
- Extend existing ECharts wrapper (`echart.client.tsx`) with graph series support
- Create new GraphQL types, service, and resolver for entity-financial correlation data
- Build React component following established patterns (SectorHeatmap reference)
- Implement rich interactions: tooltips, node selection, confidence filtering

## 2. Context Analysis

### CCW Workflow Context

**Phase Progression**:
- [x] Phase 0: User Decisions (execution method, visualization library, correlation method, entity schema, placement)
- [x] Phase 1: Context Gathering (context-package.json: 12 source files, 5 config files analyzed)
- [x] Phase 2: Exploration (4 angles: architecture, dependencies, patterns, integration-points)
- [x] Phase 3: Conflict Resolution (4 clarifications resolved with user decisions)
- [ ] Phase 4: Action Planning (current phase - generating IMPL_PLAN.md)

**Quality Gates**:
- concept-verify: Passed (4 clarifications resolved)
- action-plan-verify: Pending (recommended before /workflow:execute)

**Context Package Summary**:
- **Focus Paths**: apps/web/components/, apps/web/app/(app)/dashboard/, apps/api/src/graphql/, apps/api/src/modules/dashboard/
- **Key Files**: 12 source files with relevance scores 0.80-0.95
- **Complexity**: High (multi-layer implementation across frontend and backend)
- **Smart Context**: 12 source files, 5 config files, 5 internal dependencies, 7 external dependencies

### Project Profile

- **Type**: Enhancement (new visualization feature)
- **Scale**: Single dashboard component with backend API support
- **Tech Stack**: TypeScript, Next.js 15, NestJS 11, ECharts 5.5.0, GraphQL, MongoDB, Prisma
- **Timeline**: 8 tasks, estimated 2-3 development cycles

### Module Structure

```
apps/
├── web/                          # Next.js Frontend
│   ├── components/
│   │   └── echart.client.tsx     # ECharts wrapper (modify)
│   ├── hooks/
│   │   └── useEntityImpactGraph.ts  # New data hook
│   └── app/(app)/dashboard/
│       ├── dashboard-content.tsx # Dashboard layout (modify)
│       └── charts/
│           └── entity-impact-graph.tsx  # New component
└── api/                          # NestJS Backend
    ├── src/graphql/
    │   ├── models/
    │   │   └── entity-impact-graph.model.ts  # New GraphQL types
    │   └── resolvers/
    │       └── entity-impact-graph.resolver.ts  # New resolver
    └── src/modules/dashboard/
        └── entity-impact-graph.service.ts  # New service

packages/
└── mongo/src/models/
    └── processed-item.ts         # Entity schema reference
```

### Dependencies

**Primary**:
- ECharts 5.5.0 (graph series support built-in)
- @nestjs/graphql (GraphQL decorators)
- @apollo/client 3.11.0 (GraphQL client)
- Mongoose 8.3.2 (MongoDB ODM)
- Prisma 5.16.0 (SQL ORM)

**APIs**:
- ProcessedItem.result.entities (MongoDB - news entities)
- AkshareService.getDataByCategory (Prisma - financial data)

**Development**:
- TypeScript, ESLint, Prettier
- Turborepo (monorepo build)

### Patterns & Conventions

- **Architecture**: Modular monolith with GraphQL API layer
- **Component Design**: Dynamic imports for SSR safety, 'use client' directive
- **State Management**: Zustand stores for dashboard filters, React Query for data fetching
- **Code Style**: camelCase naming, TypeScript strict mode

## 3. Brainstorming Artifacts Reference

### Artifact Usage Strategy

**Primary Reference (Context Package)**:
- **What**: Smart context gathered by CCW's context-gather phase
- **Content**: Focus paths, dependency graph, existing patterns, module structure
- **Usage**: Tasks load this via `flow_control.pre_analysis` for environment setup

**Exploration Results**:
- **What**: Multi-angle exploration (architecture, dependencies, patterns, integration-points)
- **Content**: Critical files, conflict indicators, constraints, patterns
- **Usage**: Referenced in task planning for technical guidance

**User Decisions (Phase 0)**:
- Visualization: ECharts graph series (no new dependencies)
- Correlation: Hybrid approach (co-occurrence + correlation strength)
- Entity Schema: Extend GraphQL for full entity objects
- Placement: New row below existing charts

### Critical Files (from exploration)

| File | Relevance | Purpose |
|------|-----------|---------|
| apps/web/components/echart.client.tsx | 0.95 | ECharts wrapper - add graph series |
| packages/mongo/src/models/processed-item.ts | 0.95 | Entity schema reference |
| apps/api/src/modules/akshare/akshare.service.ts | 0.90 | Financial data service |
| apps/web/app/(app)/dashboard/dashboard-content.tsx | 0.90 | Dashboard integration point |
| apps/api/src/graphql/models/item.model.ts | 0.90 | GraphQL model patterns |
| apps/web/app/(app)/dashboard/charts/sector-heatmap.tsx | 0.88 | Chart component reference |

## 4. Implementation Strategy

### Execution Strategy

**Execution Model**: Phased with Parallel Opportunities

**Rationale**: Backend types and frontend ECharts extension can proceed in parallel. Service and resolver depend on types. Frontend component depends on both ECharts extension and backend API.

**Parallelization Opportunities**:
- IMPL-001 (ECharts extension) || IMPL-002 (GraphQL types)
- IMPL-003 (Service) can start after IMPL-002

**Serialization Requirements**:
- IMPL-004 (Resolver) depends on IMPL-003 (Service)
- IMPL-005 (Hook) depends on IMPL-001 + IMPL-004
- IMPL-006 (Component) depends on IMPL-005
- IMPL-007 (Integration) depends on IMPL-006
- IMPL-008 (Interactions) depends on IMPL-007

### Architectural Approach

**Key Architecture Decisions**:
- Use ECharts graph series (consistent with existing visualization stack)
- Hybrid correlation combining co-occurrence frequency with correlation strength
- Extend GraphQL schema for full entity objects (not just string[])
- New dashboard row for prominent visibility

**Integration Strategy**:
- Frontend: Dynamic import pattern for SSR safety
- Backend: New service in dashboard module, new resolver in graphql module
- Data Flow: GraphQL query -> Service -> MongoDB + Prisma -> Transform -> Response

### Key Dependencies

**Task Dependency Graph**:
```
IMPL-001 (ECharts) ─────────────────────┐
                                        ├──> IMPL-005 (Hook) ──> IMPL-006 (Component) ──> IMPL-007 (Integration) ──> IMPL-008 (Interactions)
IMPL-002 (Types) ──> IMPL-003 (Service) ──> IMPL-004 (Resolver) ─┘
```

**Critical Path**: IMPL-002 -> IMPL-003 -> IMPL-004 -> IMPL-005 -> IMPL-006 -> IMPL-007 -> IMPL-008

### Testing Strategy

**Testing Approach**:
- Unit testing: Jest for services and hooks
- Integration testing: GraphQL resolver tests
- E2E testing: Visual verification of graph rendering

**Coverage Targets**:
- Lines: >= 70%
- Functions: >= 70%
- Branches: >= 65%

**Quality Gates**:
- TypeScript compilation passes
- ESLint no errors
- Graph renders with sample data

## 5. Task Breakdown Summary

### Task Count

**8 tasks** (flat hierarchy, phased execution with parallel opportunities)

### Task Structure

| ID | Title | Module | Complexity | Dependencies |
|----|-------|--------|------------|--------------|
| IMPL-001 | Extend ECharts wrapper for graph series support | frontend | Low | None |
| IMPL-002 | Create GraphQL types for entity objects | backend | Medium | None |
| IMPL-003 | Create correlation service for entity-financial relationships | backend | High | IMPL-002 |
| IMPL-004 | Create GraphQL resolver for entity impact graph data | backend | Medium | IMPL-003 |
| IMPL-005 | Create useEntityImpactGraph data hook | frontend | Medium | IMPL-001, IMPL-004 |
| IMPL-006 | Create EntityImpactGraph React component | frontend | High | IMPL-005 |
| IMPL-007 | Integrate component into dashboard layout | frontend | Low | IMPL-006 |
| IMPL-008 | Add interaction features (tooltips, click events, filtering) | frontend | Medium | IMPL-007 |

### Complexity Assessment

- **High**: IMPL-003 (correlation logic), IMPL-006 (graph component)
- **Medium**: IMPL-002, IMPL-004, IMPL-005, IMPL-008
- **Low**: IMPL-001, IMPL-007

## 6. Implementation Plan (Detailed Phased Breakdown)

### Phase 1: Foundation (IMPL-001, IMPL-002)

**Tasks**: IMPL-001, IMPL-002 (can run in parallel)

**Deliverables**:
- ECharts wrapper extended with graph series support (1 case added)
- GraphQL types defined (6 types: EntityModel, EntityImpactNodeModel, EntityImpactLinkModel, EntityImpactMetadataModel, EntityImpactGraphModel, EntityImpactGraphInput)

**Success Criteria**:
- `grep 'case "graph"' apps/web/components/echart.client.tsx` returns match
- `grep -c '@ObjectType' apps/api/src/graphql/models/entity-impact-graph.model.ts` >= 5

### Phase 2: Backend API (IMPL-003, IMPL-004)

**Tasks**: IMPL-003, then IMPL-004 (sequential)

**Deliverables**:
- EntityImpactGraphService with 4 methods (getEntityImpactGraph, calculateCoOccurrence, calculateCorrelation, buildGraphData)
- EntityImpactGraphResolver with 1 query (getEntityImpactGraph)

**Success Criteria**:
- Service file exists and is injectable
- Resolver registered and query accessible via GraphQL playground

### Phase 3: Frontend Data Layer (IMPL-005)

**Tasks**: IMPL-005

**Deliverables**:
- useEntityImpactGraph hook with GraphQL integration
- GraphQL query definition added to operations

**Success Criteria**:
- Hook exports useEntityImpactGraph function
- GraphQL codegen generates types

### Phase 4: UI Component (IMPL-006, IMPL-007)

**Tasks**: IMPL-006, then IMPL-007 (sequential)

**Deliverables**:
- EntityImpactGraph component with force-directed layout
- Component integrated into dashboard layout

**Success Criteria**:
- Component renders graph with sample data
- Graph visible in dashboard below existing charts

### Phase 5: Polish (IMPL-008)

**Tasks**: IMPL-008

**Deliverables**:
- Rich tooltips showing entity details
- Node click handler with selection highlighting
- Confidence filter slider

**Success Criteria**:
- Tooltips display on hover
- Click events trigger selection
- Filter updates graph nodes

## 7. Risk Assessment & Mitigation

| Risk | Impact | Probability | Mitigation Strategy |
|------|--------|-------------|---------------------|
| ECharts graph module loading issues | Medium | Low | Follow existing installOnce pattern, test with simple graph first |
| Large entity count performance | High | Medium | Implement node limit (maxNodes parameter), consider clustering |
| Entity confidence quality varies | Medium | Medium | Add confidence threshold filter (default 0.5) |
| Correlation calculation complexity | High | Medium | Start with co-occurrence only, add correlation incrementally |
| GraphQL schema conflicts | Low | Low | Use dedicated model file, follow existing patterns |

**Critical Risks**:
- Performance with large datasets: Implement pagination/limits in service, add maxNodes parameter

**Monitoring Strategy**:
- Monitor graph render time in development
- Log correlation calculation duration
- Track node/link counts in responses

## 8. Success Criteria

**Functional Completeness**:
- [ ] ECharts graph series support added
- [ ] GraphQL types and resolver implemented
- [ ] Correlation service calculates entity-financial relationships
- [ ] React component renders force-directed graph
- [ ] Component integrated into dashboard
- [ ] Interactions (tooltips, clicks, filtering) functional

**Technical Quality**:
- [ ] TypeScript compilation passes (all 8 tasks)
- [ ] No ESLint errors
- [ ] Graph renders within 2 seconds for typical data

**Operational Readiness**:
- [ ] Component lazy-loaded for SSR safety
- [ ] Error states handled gracefully
- [ ] Loading states displayed during data fetch

**User Experience**:
- [ ] Graph clearly shows entity-financial relationships
- [ ] Tooltips provide useful context
- [ ] Filtering allows focus on high-confidence entities
