import type { SituationMonitorCategoryClassificationSource } from "./classification/category-classifier";
import type { SituationMonitorCategory } from "./situation-monitor.constants";

export interface SituationMonitorHeadline {
  id: string;
  itemMetaId?: string;
  duplicateOf?: string;
  title: string;
  titleZh?: string;
  link: string;
  source: string;
  timestamp: number;
  category: SituationMonitorCategory;
  origin: "items" | "gdelt";
  isAlert: boolean;
  alertKeyword?: string;
  summary?: string;
  summaryZh?: string;
  keyPoints?: string[];
  keyPointsZh?: string[];
  topics?: string[];
  entities?: string[];
  location?: string;
  classificationSource?: SituationMonitorCategoryClassificationSource;
  classificationConfidence?: number;
  classificationReason?: string;
}

export interface SituationMonitorEventCluster {
  id: string;
  category: SituationMonitorCategory;
  lead: SituationMonitorHeadline;
  items: SituationMonitorHeadline[];
  internalCount: number;
  externalCount: number;
  distinctSourceCount: number;
  latestTimestamp: number;
  isAlert: boolean;
  mixedSource: boolean;
}

export interface SituationMonitorAlertHeadline
  extends SituationMonitorHeadline {
  severity: "critical" | "elevated";
}

export interface SituationMonitorWorldLeader {
  id: string;
  name: string;
  title: string;
  country: string;
  flag?: string;
  since?: string;
  party?: string;
  focus?: string[];
  matchCount: number;
  headlines: Pick<
    SituationMonitorHeadline,
    "title" | "titleZh" | "link" | "source" | "timestamp"
  >[];
}

export interface SituationMonitorSituationPanel {
  id: "venezuela" | "greenland" | "iran";
  title: string;
  titleZh?: string;
  subtitle: string;
  subtitleZh?: string;
  level: "monitoring" | "elevated" | "critical";
  status: "MONITORING" | "ELEVATED" | "CRITICAL";
  headlines: Pick<
    SituationMonitorHeadline,
    "title" | "titleZh" | "link" | "source" | "timestamp"
  >[];
}

export interface SituationMonitorMarketItem {
  symbol: string;
  name: string;
  price: number;
  change: number;
  changePercent: number;
  type: "index" | "sector" | "commodity";
}

export interface SituationMonitorMarketsSnapshot {
  hasFinnhubApiKey: boolean;
  indices: SituationMonitorMarketItem[];
  sectors: SituationMonitorMarketItem[];
  commodities: SituationMonitorMarketItem[];
  vix: SituationMonitorMarketItem | null;
  error?: string;
}

export interface SituationMonitorCryptoItem {
  id: string;
  symbol: string;
  name: string;
  currentPriceUsd: number;
  change24hPercent: number;
}

export interface SituationMonitorFedIndicator {
  seriesId: string;
  name: string;
  value: number | null;
  change: number | null;
  unit: string;
}

export type SituationMonitorFedNewsType =
  | "monetary"
  | "powell"
  | "speech"
  | "testimony"
  | "announcement";

export interface SituationMonitorFedNewsItem {
  id: string;
  title: string;
  titleZh?: string;
  link: string;
  description: string;
  descriptionZh?: string;
  pubDate: string;
  timestamp: number;
  type: SituationMonitorFedNewsType;
  typeLabel: string;
  typeLabelZh?: string;
  isPowellRelated: boolean;
  hasVideo: boolean;
}

export interface SituationMonitorMoneyPrinter {
  valueTrillions: number;
  changeTrillions: number;
  changePercent: number;
  percentOfMax: number;
}

export interface SituationMonitorFedSnapshot {
  hasFredApiKey: boolean;
  indicators: SituationMonitorFedIndicator[];
  moneyPrinter: SituationMonitorMoneyPrinter | null;
  news: SituationMonitorFedNewsItem[];
  error?: string;
}

export interface SituationMonitorPizzintSnapshot {
  defcon: number;
  adjustedScore: number;
  openLocations: number;
  activeSpikes: number;
  avgPop: number;
  updatedAt: string;
}

export interface SituationMonitorTensionPair {
  id: string;
  label: string;
  score: number;
  changePercent: number;
  trend: "rising" | "stable" | "falling";
  countries: string[];
  updatedAt: string;
}

export type SituationMonitorMatchReasonCode =
  | "keyword"
  | "topic"
  | "entity"
  | "source"
  | "semantic"
  | "rerank"
  | "geo";

export interface SituationMonitorMatchReason {
  code: SituationMonitorMatchReasonCode;
  label: string;
  matchedValues?: string[];
  score?: number;
}

export type SituationMonitorMatchGeoStatus =
  | "not_configured"
  | "matched"
  | "country_match"
  | "conflict"
  | "unresolved";

export interface SituationMonitorMatchResult {
  itemKey: string;
  itemType:
    | "headline"
    | "alert"
    | "situation"
    | "telegram"
    | "oref_alert"
    | "oref_history";
  monitorId: string;
  monitorKind: "manual" | "system_sync";
  monitorName: string;
  monitorColor?: string;
  score: number;
  geoStatus: SituationMonitorMatchGeoStatus;
  matchedTerms: string[];
  reasons: SituationMonitorMatchReason[];
  itemMetaId?: string;
  title: string;
  titleZh?: string;
  summary?: string;
  summaryZh?: string;
  link: string;
  source: string;
  timestamp: number;
  category?: string;
}
