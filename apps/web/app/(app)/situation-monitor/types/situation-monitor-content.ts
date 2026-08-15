import type { SituationMonitorMatchResult } from "./situation-monitor-monitors";


export const TELEGRAM_TOPIC_PRESETS = [
  "breaking",
  "conflict",
  "alerts",
  "osint",
  "politics",
  "middleeast",
  "geopolitics",
  "cyber",
  "other",
] as const;

export interface SituationMonitorFeedbackPayload {
  signalType: "narrative" | "correlation";
  signalId: string;
  label: "false_positive" | "false_negative";
  item?: {
    itemMetaId?: string;
    title?: string;
    source?: string;
    link?: string;
  } | null;
}

export interface HeadlineRef {
  title: string;
  titleZh?: string;
  link: string;
  source: string;
  itemMetaId?: string;
}

export interface SignalFeedback {
  falsePositive: number;
  falseNegative: number;
}

export interface SignalLearning {
  boostedTokens: string[];
  blockedTokens: string[];
  suppressedCount: number;
}

export interface EmergingPattern {
  id: string;
  name: string;
  nameZh?: string;
  category: string;
  count: number;
  level: "high" | "elevated" | "emerging";
  sources: string[];
  headlines: HeadlineRef[];
  feedback?: SignalFeedback;
  learning?: SignalLearning;
}

export interface MomentumSignal {
  id: string;
  name: string;
  nameZh?: string;
  category: string;
  current: number;
  delta: number;
  momentum: "surging" | "rising" | "stable";
  headlines: HeadlineRef[];
  feedback?: SignalFeedback;
  learning?: SignalLearning;
}

export interface PredictiveSignal {
  id: string;
  name: string;
  nameZh?: string;
  category: string;
  score: number;
  confidence: number;
  prediction: string;
  predictionZh?: string;
  level: "high" | "medium" | "low";
  headlines: HeadlineRef[];
  feedback?: SignalFeedback;
  learning?: SignalLearning;
}

export interface CrossSourceCorrelation {
  id: string;
  name: string;
  nameZh?: string;
  category: string;
  sourceCount: number;
  sources: string[];
  level: "high" | "elevated" | "emerging";
  headlines: HeadlineRef[];
  feedback?: SignalFeedback;
  learning?: SignalLearning;
}

export interface CorrelationResults {
  emergingPatterns: EmergingPattern[];
  momentumSignals: MomentumSignal[];
  crossSourceCorrelations: CrossSourceCorrelation[];
  predictiveSignals: PredictiveSignal[];
}

export type SituationMonitorCategory =
  | "politics"
  | "tech"
  | "finance"
  | "gov"
  | "ai"
  | "intel";

export const SITUATION_MONITOR_CATEGORY_KEYS: SituationMonitorCategory[] = [
  "politics",
  "tech",
  "finance",
  "gov",
  "ai",
  "intel",
];

export interface SituationMonitorExternalSnapshotCategoryState {
  status: "fresh" | "reused" | "empty";
  articleCount: number;
  contentGeneratedAt: string | null;
  reasonCode?: string;
}

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

export interface SituationMonitorWarning {
  code: string;
  source: "core" | "external" | "gdelt" | "crawl" | "telegram" | "oref";
  severity: "info" | "warning" | "error";
  message: string;
  detail?: string;
}

export interface SituationMonitorAlertHeadline extends SituationMonitorHeadline {
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
  headlines: {
    title: string;
    titleZh?: string;
    link: string;
    source: string;
    timestamp: number;
  }[];
}

export interface SituationMonitorSituationPanel {
  id: "venezuela" | "greenland" | "iran";
  title: string;
  titleZh?: string;
  subtitle: string;
  subtitleZh?: string;
  level: "monitoring" | "elevated" | "critical";
  status: "MONITORING" | "ELEVATED" | "CRITICAL";
  headlines: {
    title: string;
    titleZh?: string;
    link: string;
    source: string;
    timestamp: number;
  }[];
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

export interface SituationMonitorMoneyPrinter {
  valueTrillions: number;
  changeTrillions: number;
  changePercent: number;
  percentOfMax: number;
}

export interface SituationMonitorFedNewsItem {
  id: string;
  title: string;
  titleZh?: string;
  link: string;
  description: string;
  descriptionZh?: string;
  pubDate: string;
  timestamp: number;
  type: "monetary" | "powell" | "speech" | "testimony" | "announcement";
  typeLabel: string;
  typeLabelZh?: string;
  isPowellRelated: boolean;
  hasVideo: boolean;
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

export interface CrossSourceRadarCluster {
  id: string;
  itemCount: number;
  sources: string[];
  samples: {
    title: string;
    titleZh?: string;
    link: string;
    source: string;
    timestamp: number;
    itemMetaId?: string;
  }[];
}

export interface CrossSourceRadar {
  consistency: number;
  divergence: number;
  clusterCount: number;
  clusters: CrossSourceRadarCluster[];
  outlierSources: string[];
}

export interface FringeMainstreamPathStep {
  tier: "fringe" | "alternative" | "mainstream" | "unknown";
  firstSeenAt: number;
  lastSeenAt: number;
  count: number;
  sources: string[];
}

export interface FringeMainstreamPath {
  steps: FringeMainstreamPathStep[];
  lagToMainstreamMs?: number;
}

export interface CitationLink {
  from: string;
  to: string;
  weight: number;
}

export interface CitationChain {
  nodes: string[];
  links: CitationLink[];
  topCited: { source: string; weight: number }[];
  citedByCount: number;
}

export interface CredibilityAssessment {
  score: number;
  level: "high" | "medium" | "low";
  reasons: string[];
  components: {
    sourceReliability: number;
    corroboration: number;
    citationSupport: number;
    divergence: number;
    feedbackPenalty: number;
  };
}

export interface NarrativePropagationModel {
  crossSourceRadar: CrossSourceRadar;
  fringeToMainstreamPath: FringeMainstreamPath;
  credibility: CredibilityAssessment;
  citationChain: CitationChain;
}

export interface NarrativeData {
  id: string;
  name: string;
  nameZh?: string;
  category: string;
  severity: "watch" | "emerging" | "spreading" | "disinfo";
  count: number;
  fringeCount: number;
  alternativeCount: number;
  mainstreamCount: number;
  sources: string[];
  headlines: {
    title: string;
    titleZh?: string;
    link: string;
    source: string;
    timestamp: number;
    itemMetaId?: string;
  }[];
  keywords: string[];
  feedback?: { falsePositive: number; falseNegative: number };
  model?: NarrativePropagationModel;
  learning?: {
    boostedTokens: string[];
    blockedTokens: string[];
    suppressedCount: number;
  };
}

export interface FringeToMainstream extends NarrativeData {
  status: "crossing";
  crossoverLevel: number;
}

export interface EmergingFringe extends NarrativeData {
  status: "emerging" | "spreading" | "viral";
}

export interface NarrativeResults {
  emergingFringe: EmergingFringe[];
  fringeToMainstream: FringeToMainstream[];
  disinfoSignals: NarrativeData[];
  narrativeWatch: NarrativeData[];
}

export interface MainCharacterEntry {
  name: string;
  count: number;
  rank: number;
}

export interface SituationMonitorCategoryDiagnostics {
  internalCount: number;
  gdeltFallbackCount: number;
  totalCount: number;
  clusterCount: number;
  mixedSourceClusterCount: number;
  distinctSourceCount: number;
}

export interface SituationMonitorInsightsDiagnostics {
  requestedScope: "tagged" | "all";
  effectiveScope: "tagged" | "all";
  categories: Record<
    SituationMonitorCategory,
    SituationMonitorCategoryDiagnostics
  >;
}

export interface SituationMonitorCoverageSummary {
  mode: "internal+external" | "external-only" | "internal-only" | "empty";
  articleCount: number;
  clusterCount: number;
  internalAnalyzedItems: number;
  externalAnalyzedItems: number;
  mixedSourceClusterCount: number;
  dedupeRatio: number | null;
  avgSourcesPerCluster: number | null;
  visibleCategoryCount: number;
  missingCategories: SituationMonitorCategory[];
  hasOlderItemsOutsideWindow: boolean;
  recommendedWindowHours: number | null;
}

export interface SituationMonitorInsightsResponse {
  generatedAt: string;
  windowHours: number;
  maxItems: number;
  analyzedItems: number;
  diagnostics?: SituationMonitorInsightsDiagnostics;
  coverageSummary?: SituationMonitorCoverageSummary;
  warnings?: SituationMonitorWarning[];
  externalSnapshot?: {
    source: "scheduler";
    status: "completed" | "partial" | "failed" | "idle";
    stale: boolean;
    partial: boolean;
    generatedAt: string | null;
    expiresAt: string | null;
    availableCategoryCount: number;
    categories: Record<
      SituationMonitorCategory,
      SituationMonitorExternalSnapshotCategoryState
    >;
    warnings: SituationMonitorWarning[];
  };
  translation?: { target: "zh-CN"; applied: boolean; error?: string };
  headlines?: Record<SituationMonitorCategory, SituationMonitorHeadline[]>;
  clusters?: Record<SituationMonitorCategory, SituationMonitorEventCluster[]>;
  alerts?: SituationMonitorAlertHeadline[];
  leaders?: SituationMonitorWorldLeader[];
  situations?: SituationMonitorSituationPanel[];
  markets?: SituationMonitorMarketsSnapshot;
  crypto?: SituationMonitorCryptoItem[];
  fed?: SituationMonitorFedSnapshot;
  pizzint?: SituationMonitorPizzintSnapshot;
  tensions?: SituationMonitorTensionPair[];
  correlation?: CorrelationResults | null;
  correlationSummary?: {
    totalSignals: number;
    status: string;
    statusZh?: string;
  };
  narrative?: NarrativeResults | null;
  narrativeSummary?: { total: number; status: string; statusZh?: string };
  mainCharacter?: {
    characters: MainCharacterEntry[];
    topCharacter: MainCharacterEntry | null;
  };
  mainCharacterSummary?: {
    name: string;
    count: number;
    status: string;
    statusZh?: string;
  };
  monitorMatches?: SituationMonitorMatchResult[];
}

export interface SituationMonitorCatalogResponse {
  narratives: {
    id: string;
    name: string;
    category: string;
    severity: string;
  }[];
  correlations: { id: string; name: string; category: string }[];
  refreshReadiness: {
    activeSourceCount: number;
    backendRefreshTargets: {
      crawl: boolean;
      telegram: boolean;
      oref: boolean;
      any: boolean;
    };
  };
}
