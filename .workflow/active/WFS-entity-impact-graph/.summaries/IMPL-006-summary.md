# Task: IMPL-006 Create EntityImpactGraph React component

## Implementation Summary

### Files Created
- `apps/web/app/(app)/dashboard/charts/entity-impact-graph.tsx`: New React component for force-directed graph visualization

### Content Added

#### Component: EntityImpactGraph
**File**: `apps/web/app/(app)/dashboard/charts/entity-impact-graph.tsx`

**Purpose**: Force-directed graph visualization showing relationships between news entities (persons, organizations) and financial instruments (stocks, commodities).

**Features**:
- ECharts graph series with force layout
- 4 node categories with distinct styling (person: blue, organization: green, stock: orange, commodity: purple)
- 2 link types with visual differentiation (co-occurrence: solid, correlation: dashed)
- Interactive tooltips showing entity details
- Click events for node selection
- Loading, error, and empty states following SectorHeatmap pattern
- Metadata display showing node/link counts

#### Constants
- **CATEGORY_CONFIG** (`line 20-26`): Maps entity types to visual properties (color, symbol, index)
- **DEFAULT_CATEGORY** (`line 31`): Fallback styling for unknown entity types

#### Helper Functions
- **getCategoryConfig(type: string)** (`line 36-39`): Returns category configuration for a node type
- **transformNodes(nodes, colors)** (`line 44-72`): Transforms EntityImpactNode[] to ECharts node format
- **transformLinks(links)** (`line 77-99`): Transforms EntityImpactLink[] to ECharts link format

#### ECharts Configuration
- **Series Type**: `graph` with `force` layout
- **Force Parameters**: repulsion: 500, gravity: 0.1, edgeLength: [50, 200]
- **Interactions**: roam, draggable, emphasis with adjacency focus

## Outputs for Dependent Tasks

### Available Components
```typescript
// Import the EntityImpactGraph component
import { EntityImpactGraph } from "@/app/(app)/dashboard/charts/entity-impact-graph";
```

### Integration Points
- **Dashboard Integration**: Add `<EntityImpactGraph />` to dashboard-content.tsx grid section
- **Height**: Component renders at 400px height (configurable via wrapper)
- **Data Source**: Uses `useEntityImpactGraph` hook with dashboard range store integration

### Usage Examples
```tsx
// Basic usage in dashboard
import { EntityImpactGraph } from "@/app/(app)/dashboard/charts/entity-impact-graph";

function DashboardContent() {
  return (
    <div className="grid grid-cols-1 gap-4">
      {/* Other charts */}
      <EntityImpactGraph />
    </div>
  );
}
```

### Component Props
The component currently has no props - it uses internal hooks for data fetching:
- `useEntityImpactGraph({ minConfidence: 0.5, maxNodes: 100 })`
- `useChartTheme()` for consistent styling
- `useDashboardRangeStore()` (via hook) for date range

### Styling Integration
- Uses `useChartTheme` hook for consistent theming
- Respects dashboard color scheme via CSS variables
- Node colors are category-specific (person/organization/stock/commodity)

## Acceptance Criteria Verification

| Criteria | Status | Verification |
|----------|--------|--------------|
| Component file created | PASS | `ls apps/web/app/(app)/dashboard/charts/entity-impact-graph.tsx` |
| Component exported | PASS | `grep "export function EntityImpactGraph"` returns match |
| ECharts graph series configured | PASS | `grep 'type: "graph"'` returns match |
| Force layout configured | PASS | `grep 'layout: "force"'` returns match |
| 4 node categories | PASS | CATEGORY_CONFIG defines person, organization, stock, commodity |
| 2 link types | PASS | transformLinks handles co-occurrence (solid) and correlation (dashed) |

## Status: COMPLETE
