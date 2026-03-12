export const ECONOMIC_DASHBOARD_REFRESH_PRESET = {
  keyMonitor: "keyMonitor",
  militaryAlert: "militaryAlert",
  economicAlert: "economicAlert",
  economicShort: "economicShort",
  economicMedium: "economicMedium",
  economicLong: "economicLong",
  livelihoodPrices: "livelihoodPrices"
} as const;

export type EconomicDashboardRefreshPreset =
  (typeof ECONOMIC_DASHBOARD_REFRESH_PRESET)[keyof typeof ECONOMIC_DASHBOARD_REFRESH_PRESET];

export const ECONOMIC_DASHBOARD_REFRESH_PRESET_ORDER = [
  ECONOMIC_DASHBOARD_REFRESH_PRESET.keyMonitor,
  ECONOMIC_DASHBOARD_REFRESH_PRESET.militaryAlert,
  ECONOMIC_DASHBOARD_REFRESH_PRESET.economicAlert,
  ECONOMIC_DASHBOARD_REFRESH_PRESET.economicShort,
  ECONOMIC_DASHBOARD_REFRESH_PRESET.economicMedium,
  ECONOMIC_DASHBOARD_REFRESH_PRESET.economicLong,
  ECONOMIC_DASHBOARD_REFRESH_PRESET.livelihoodPrices
] as const satisfies readonly EconomicDashboardRefreshPreset[];

export const ECONOMIC_DASHBOARD_REFRESH_PRESET_CONFIG = {
  [ECONOMIC_DASHBOARD_REFRESH_PRESET.keyMonitor]: {
    categoryKey: "key-monitor",
    labelKey: "dashboard.tabs.keyMonitor"
  },
  [ECONOMIC_DASHBOARD_REFRESH_PRESET.militaryAlert]: {
    categoryKey: "military-alert",
    labelKey: "dashboard.tabs.militaryAlert"
  },
  [ECONOMIC_DASHBOARD_REFRESH_PRESET.economicAlert]: {
    categoryKey: "economic-alert",
    labelKey: "dashboard.tabs.economicAlert"
  },
  [ECONOMIC_DASHBOARD_REFRESH_PRESET.economicShort]: {
    categoryKey: "economic-short",
    labelKey: "dashboard.tabs.economicShort"
  },
  [ECONOMIC_DASHBOARD_REFRESH_PRESET.economicMedium]: {
    categoryKey: "economic-medium",
    labelKey: "dashboard.tabs.economicMedium"
  },
  [ECONOMIC_DASHBOARD_REFRESH_PRESET.economicLong]: {
    categoryKey: "economic-long",
    labelKey: "dashboard.tabs.economicLong"
  },
  [ECONOMIC_DASHBOARD_REFRESH_PRESET.livelihoodPrices]: {
    categoryKey: "livelihood-prices",
    labelKey: "dashboard.tabs.livelihoodPrices"
  }
} as const satisfies Record<
  EconomicDashboardRefreshPreset,
  { categoryKey: string; labelKey: string }
>;

