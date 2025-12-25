export interface DemoEconomicMetricDefinition {
  slug: string;
  displayName: string;
  baseValue: number;
  volatility: number;
}

export const DEMO_ECONOMIC_METRICS: DemoEconomicMetricDefinition[] = [
  {
    slug: 'global-conflict-index',
    displayName: 'Global Conflict Index',
    baseValue: 65,
    volatility: 5,
  },
  {
    slug: 'market-sentiment',
    displayName: 'Market Sentiment',
    baseValue: 50,
    volatility: 10,
  },
  {
    slug: 'resource-scarcity',
    displayName: 'Resource Scarcity',
    baseValue: 60,
    volatility: 3,
  },
  {
    slug: 'supply-chain-stability',
    displayName: 'Supply Chain Stability',
    baseValue: 85,
    volatility: 2,
  },
];
