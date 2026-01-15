# IMPL-003 Summary: Create correlation service for entity-financial relationships

## Status: Completed

## Files Created
- `apps/api/src/modules/dashboard/entity-impact-graph.service.ts`

## Files Modified
- `apps/api/src/modules/dashboard/dashboard.module.ts` - Added EntityImpactGraphService to providers and exports

## Service Structure

**EntityImpactGraphService** with @Injectable() decorator:
- Injects `PrismaService` for database access
- Uses `ProcessedItemModel` from `@modular/mongo` for entity data

## Methods Implemented (5 async methods)

1. **`getEntityImpactGraph(input)`** - Main entry point
   - Combines co-occurrence and correlation analysis
   - Supports configurable parameters: minCoOccurrence, minCorrelation, maxNodes, categories
   - Returns ECharts-compatible graph data structure

2. **`calculateCoOccurrence(orgId, startDate, endDate, minCount)`**
   - Queries ProcessedItem.result.entities from MongoDB
   - Builds entity pair co-occurrence map from news articles
   - Filters by confidence threshold (0.5) and minimum count

3. **`calculateCorrelation(orgId, startDate, endDate, minCorrelation)`**
   - Gets entity mention frequency time series
   - Gets financial instrument time series from Prisma
   - Calculates Pearson correlation with p-value approximation
   - Filters by minimum correlation and statistical significance (p < 0.05)

4. **`buildGraphData(coOccurrences, correlations, allowedCategories, maxNodes)`**
   - Converts analysis results to ECharts graph format
   - Supports 4 node categories: person, organization, stock, commodity
   - Generates 2 link types: co-occurrence, correlation

## Supporting Private Methods
- `getEntityMentionTimeSeries()` - Entity frequency by date
- `getFinancialTimeSeries()` - Financial data from Prisma
- `alignTimeSeries()` - Align two time series by date
- `pearsonCorrelation()` - Statistical correlation calculation
- `approximatePValue()` / `normalCDF()` - P-value approximation

## Integration Points
- This service will be used by IMPL-004 (GraphQL resolver)
- Uses hybrid correlation approach as specified in user decisions
