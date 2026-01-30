export const NEWS_INDICATOR_RECOMMENDED_SLUGS = [
  "gold_futures_main",
  "crude_oil_futures_main",
  "copper_futures_main",
  "gov_bond_futures_main",
  "natural_gas_futures_main",
  "platinum_spot_sge",
  "palladium_spot_sge",
  "china_treasury_yield_curve",
  "us_treasury_yield_curve",
  "shanghai_composite_index",
  "csi300_index",
  "sz_component_index",
  "csi1000_index",
  "sp500_index",
  "china_fx_mid_rates",
  "rmb_fx_cswap_curve"
] as const;

export type NewsIndicatorRecommendedSlug = (typeof NEWS_INDICATOR_RECOMMENDED_SLUGS)[number];

