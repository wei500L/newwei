# Task: IMPL-004 Create GraphQL resolver for entity impact graph data

## Implementation Summary

### Files Created
- `apps/api/src/graphql/resolvers/entity-impact-graph.resolver.ts`: New GraphQL resolver for entity impact graph queries

### Files Modified
- `apps/api/src/graphql/graphql.module.ts`: Added import and provider registration for EntityImpactGraphResolver

### Content Added

- **EntityImpactGraphResolver** (`apps/api/src/graphql/resolvers/entity-impact-graph.resolver.ts`):
  - `@Resolver()` class with `@UseGuards(GqlAuthGuard, GqlPermissionsGuard)` decorators
  - Constructor injection of `EntityImpactGraphService`
  - `getEntityImpactGraph()` query method with `@HasPermission("dashboard.read")` decorator

- **getEntityImpactGraph Query** (`entity-impact-graph.resolver.ts:18-56`):
  - Accepts optional `EntityImpactGraphInput` with fields: `startDate`, `endDate`, `minConfidence`, `maxNodes`
  - Returns `EntityImpactGraphModel` with nodes, links, and metadata
  - Default date range: last 30 days
  - Default minConfidence: 0.5
  - Default maxNodes: 100

## Outputs for Dependent Tasks

### Available Components
```typescript
// New resolver ready for GraphQL queries
import { EntityImpactGraphResolver } from "./resolvers/entity-impact-graph.resolver";
```

### Integration Points
- **GraphQL Query**: `getEntityImpactGraph(input: EntityImpactGraphInput): EntityImpactGraphModel`
- **Permission**: Requires `dashboard.read` permission
- **Guards**: Protected by `GqlAuthGuard` and `GqlPermissionsGuard`

### Usage Examples
```graphql
query GetEntityImpactGraph($input: EntityImpactGraphInput) {
  getEntityImpactGraph(input: $input) {
    nodes {
      id
      name
      category
      type
      value
    }
    links {
      source
      target
      value
      type
    }
    metadata {
      totalNodes
      totalLinks
      generatedAt
    }
  }
}
```

### Input Parameters
```graphql
input EntityImpactGraphInput {
  startDate: DateTime      # Optional, defaults to 30 days ago
  endDate: DateTime        # Optional, defaults to now
  minConfidence: Float     # Optional, defaults to 0.5
  maxNodes: Int            # Optional, defaults to 100
}
```

## Acceptance Criteria Verification

| Criteria | Status | Verification |
|----------|--------|--------------|
| 1 resolver file created | PASS | `ls apps/api/src/graphql/resolvers/entity-impact-graph.resolver.ts` |
| 1 query method defined | PASS | `grep '@Query' entity-impact-graph.resolver.ts` found at line 17 |
| Guards applied | PASS | `grep '@UseGuards' entity-impact-graph.resolver.ts` found at line 12 |
| Resolver registered | PASS | `EntityImpactGraphResolver` added to graphql.module.ts providers |

## Status: COMPLETE
