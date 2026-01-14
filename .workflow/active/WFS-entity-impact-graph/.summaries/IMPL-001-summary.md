# IMPL-001 Summary: Extend ECharts wrapper for graph series support

## Status: Completed

## Changes Made
- Added `case "graph"` to the `ensureOptionModules` switch statement in `apps/web/components/echart.client.tsx`
- Added dynamic import for `echarts/lib/chart/graph/install.js` following the existing `installOnce` pattern

## File Modified
- `apps/web/components/echart.client.tsx` (lines 274-281)

## Code Added
```typescript
case "graph":
  promises.push(
    installOnce("chart:graph", async () => {
      const m = await import("echarts/lib/chart/graph/install.js");
      return m.install;
    }),
  );
  break;
```

## Verification
- `case "graph"` found at line 274
- `chart:graph` installOnce key found at line 276
- `echarts/lib/chart/graph/install.js` import path verified
- Pattern matches existing chart types (line, bar, pie, scatter, radar, candlestick, gauge, heatmap, map, treemap)

## Integration Points
- This enables the EntityImpactGraph component (IMPL-006) to use ECharts graph series
- No breaking changes to existing chart functionality
