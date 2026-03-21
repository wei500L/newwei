import type {
  CrawlFrontierPageType,
  CrawlSiteExecutionMode,
  CrawlSiteProfileConfig,
} from './crawl.types';

export enum CrawlStrategyWorkflowNodeType {
  SeedDiscovery = 'seed-discovery',
  ListDiscovery = 'list-discovery',
  DeepDiscovery = 'deep-discovery',
  UrlFilter = 'url-filter',
  ContentFilter = 'content-filter',
  PageTypeClassifier = 'page-type-classifier',
  UrlScorer = 'url-scorer',
  FreshnessScorer = 'freshness-scorer',
  Branch = 'branch',
  BudgetControl = 'budget-control',
  FallbackStrategy = 'fallback-strategy',
  PersistResult = 'persist-result',
}

export enum CrawlStrategyWorkflowRunKind {
  Trial = 'trial',
  ProfilePreview = 'profile_preview',
  NewsSourcePreview = 'news_source_preview',
  FrontierCompile = 'frontier_compile',
  FrontierRun = 'frontier_run',
}

export type CrawlStrategyWorkflowOrigin = 'bound' | 'legacy_bridge';

export interface CrawlStrategyWorkflowNodePosition {
  x: number;
  y: number;
}

export interface CrawlStrategyWorkflowNodeDefinition {
  id: string;
  type: CrawlStrategyWorkflowNodeType;
  label: string;
  position: CrawlStrategyWorkflowNodePosition;
  config: Record<string, unknown>;
  uiState?: Record<string, unknown>;
}

export interface CrawlStrategyWorkflowEdgeDefinition {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
  condition?: string | null;
  priority?: number | null;
}

export interface CrawlStrategyWorkflowSettings {
  executionMode: CrawlSiteExecutionMode;
  maxDepth: number;
  maxPages: number;
  timeoutMs: number;
  concurrency: number;
  robotsPolicy: 'respect' | 'ignore';
  domainScope: 'inherit_profile' | 'registrable_domain' | 'strict_hosts';
}

export interface CrawlStrategyWorkflowDefinition {
  version: 1;
  metadata: {
    description?: string | null;
    template?: string | null;
    tags?: string[];
  };
  settings: CrawlStrategyWorkflowSettings;
  nodes: CrawlStrategyWorkflowNodeDefinition[];
  edges: CrawlStrategyWorkflowEdgeDefinition[];
}

export type CrawlStrategyParameterSourceKind =
  | 'system_default'
  | 'legacy_profile'
  | 'legacy_template'
  | 'workflow'
  | 'runtime_override';

export interface CrawlStrategyParameterSource {
  key: string;
  value: unknown;
  source: CrawlStrategyParameterSourceKind;
}

export interface CrawlStrategyCandidateTraceEntry {
  nodeId: string;
  nodeType: CrawlStrategyWorkflowNodeType | string;
  action:
    | 'discovered'
    | 'classified'
    | 'filtered'
    | 'scored'
    | 'branched'
    | 'budgeted'
    | 'fallback'
    | 'persisted';
  message: string;
  accepted?: boolean;
  scoreDelta?: number;
  freshnessDelta?: number;
  ruleHits?: string[];
  rejectedReason?: string | null;
  beforeSnapshot?: Record<string, unknown>;
  afterSnapshot?: Record<string, unknown>;
  details?: Record<string, unknown>;
  timestamp: string;
}

export interface CrawlStrategyWorkflowCandidate {
  id: string;
  url: string;
  title?: string;
  description?: string;
  author?: string;
  pageType?: CrawlFrontierPageType;
  relevanceScore?: number;
  score?: number;
  freshnessScore?: number;
  qualityScore?: number;
  publishedAt?: string | null;
  crawledAt?: string | null;
  effectiveAt?: string | null;
  status: 'active' | 'selected' | 'rejected';
  rejectedByNodeId?: string | null;
  rejectedReason?: string | null;
  sourceNodeId: string;
  metadata: Record<string, unknown>;
  trace: CrawlStrategyCandidateTraceEntry[];
}

export interface CrawlStrategyWorkflowStepResult {
  stepKey?: string;
  nodeId: string;
  nodeType: CrawlStrategyWorkflowNodeType | string;
  label: string;
  status: 'pending' | 'queued' | 'running' | 'completed' | 'failed' | 'skipped';
  durationMs: number;
  inputCount: number;
  outputCount: number;
  rejectedCount: number;
  sampleUrls: string[];
  metrics?: Record<string, unknown>;
  error?: string | null;
}

export interface CrawlStrategyWorkflowRunEvent {
  id?: string;
  sequence?: number;
  level: 'info' | 'warn' | 'error';
  eventType: string;
  nodeId?: string | null;
  nodeType?: CrawlStrategyWorkflowNodeType | string | null;
  message: string;
  triggerReason?: string | null;
  beforeCount?: number | null;
  afterCount?: number | null;
  rescuedCount?: number | null;
  details?: Record<string, unknown>;
  timestamp: string;
}

export interface CrawlStrategyWorkflowRunResult {
  definition: CrawlStrategyWorkflowDefinition;
  steps: CrawlStrategyWorkflowStepResult[];
  candidates: CrawlStrategyWorkflowCandidate[];
  selectedCandidates: CrawlStrategyWorkflowCandidate[];
  parameterSources: CrawlStrategyParameterSource[];
  systemEvents: CrawlStrategyWorkflowRunEvent[];
}

export interface CrawlStrategyWorkflowNodeSchema {
  type: CrawlStrategyWorkflowNodeType;
  displayName: string;
  category: 'discovery' | 'filter' | 'scorer' | 'control' | 'output';
  description: string;
  defaultLabel: string;
  supportsTrialRun: boolean;
  configSchema: Record<string, unknown>;
  defaults: Record<string, unknown>;
}

export interface CrawlStrategyCompiledProfileOverlay {
  executionMode?: CrawlSiteExecutionMode;
  configPatch: Partial<CrawlSiteProfileConfig>;
  parameterSources: CrawlStrategyParameterSource[];
  workflowSummary?: {
    workflowId: string;
    workflowVersionId: string;
    workflowName: string;
    version: number;
  };
}

export interface CrawlStrategyCompiledNewsSourceOverlay {
  crawlOptions?: Record<string, unknown>;
  seed?: Record<string, unknown>;
  keywords?: string[];
  parameterSources: CrawlStrategyParameterSource[];
  workflowSummary?: {
    workflowId: string;
    workflowVersionId: string;
    workflowName: string;
    version: number;
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function createEmptyWorkflowDefinition(
  seedUrl?: string,
): CrawlStrategyWorkflowDefinition {
  return {
    version: 1,
    metadata: {
      description: 'Unified crawl strategy workflow',
      template: 'blank',
      tags: [],
    },
    settings: {
      executionMode: 'hybrid',
      maxDepth: 3,
      maxPages: 60,
      timeoutMs: 15_000,
      concurrency: 2,
      robotsPolicy: 'respect',
      domainScope: 'registrable_domain',
    },
    nodes: [
      {
        id: 'seed-discovery',
        type: CrawlStrategyWorkflowNodeType.SeedDiscovery,
        label: 'Seed Discovery',
        position: { x: 80, y: 120 },
        config: {
          mode: 'sitemap',
          seedUrl: seedUrl ?? '',
          maxUrls: 40,
        },
      },
      {
        id: 'url-filter',
        type: CrawlStrategyWorkflowNodeType.UrlFilter,
        label: 'URL Filter',
        position: { x: 360, y: 120 },
        config: {
          includePatterns: [],
          excludePatterns: [],
          blockedDomains: [],
          allowedHosts: [],
          denyKeywords: [],
        },
      },
      {
        id: 'page-type-classifier',
        type: CrawlStrategyWorkflowNodeType.PageTypeClassifier,
        label: 'Page Type',
        position: { x: 640, y: 120 },
        config: {},
      },
      {
        id: 'url-scorer',
        type: CrawlStrategyWorkflowNodeType.UrlScorer,
        label: 'URL Score',
        position: { x: 920, y: 120 },
        config: {
          keywordBoosts: [],
        },
      },
      {
        id: 'freshness-scorer',
        type: CrawlStrategyWorkflowNodeType.FreshnessScorer,
        label: 'Freshness',
        position: { x: 1200, y: 120 },
        config: {
          recentHours: 24,
          weekHours: 168,
          monthHours: 720,
        },
      },
      {
        id: 'budget-control',
        type: CrawlStrategyWorkflowNodeType.BudgetControl,
        label: 'Budget Control',
        position: { x: 1480, y: 120 },
        config: {
          keepTopK: 20,
          maxPages: 60,
          maxDepth: 3,
          minScore: 0,
        },
      },
      {
        id: 'persist-result',
        type: CrawlStrategyWorkflowNodeType.PersistResult,
        label: 'Persist Result',
        position: { x: 1760, y: 120 },
        config: {
          selectTopK: 20,
        },
      },
    ],
    edges: [
      {
        id: 'seed-discovery->url-filter',
        source: 'seed-discovery',
        target: 'url-filter',
      },
      {
        id: 'url-filter->page-type-classifier',
        source: 'url-filter',
        target: 'page-type-classifier',
      },
      {
        id: 'page-type-classifier->url-scorer',
        source: 'page-type-classifier',
        target: 'url-scorer',
      },
      {
        id: 'url-scorer->freshness-scorer',
        source: 'url-scorer',
        target: 'freshness-scorer',
      },
      {
        id: 'freshness-scorer->budget-control',
        source: 'freshness-scorer',
        target: 'budget-control',
      },
      {
        id: 'budget-control->persist-result',
        source: 'budget-control',
        target: 'persist-result',
      },
    ],
  };
}
