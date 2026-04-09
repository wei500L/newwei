import { Injectable } from '@nestjs/common';

import { normalizeCrawlSiteProfileConfig } from './crawl-frontier.utils';
import {
  CrawlStrategyWorkflowNodeType,
  createEmptyWorkflowDefinition,
  isRecord,
  type CrawlStrategyWorkflowDefinition,
} from './crawl-strategy.types';
import type {
  CrawlSiteExecutionMode,
  CrawlSiteProfileConfig,
  CrawlSiteProfileRecord,
} from './crawl.types';

interface LegacyNewsSourceInput {
  url: string;
  config?: Record<string, unknown> | null;
  crawlOptions?: Record<string, unknown> | null;
}

@Injectable()
export class CrawlStrategyLegacyBridgeService {
  buildWorkflowFromProfile(
    profile: Pick<
      CrawlSiteProfileRecord,
      'name' | 'description' | 'executionMode' | 'config'
    >,
    seedUrl?: string,
  ): CrawlStrategyWorkflowDefinition {
    const config = normalizeCrawlSiteProfileConfig(profile.config);
    const definition = createEmptyWorkflowDefinition(seedUrl);
    definition.metadata.description =
      profile.description ?? `Generated from profile ${profile.name}`;
    definition.metadata.template = 'legacy_profile';
    definition.settings.executionMode = profile.executionMode;
    definition.settings.maxDepth = config.layeredOptions?.maxDepth ?? 3;
    definition.settings.maxPages = config.layeredOptions?.maxPages ?? 60;
    definition.settings.robotsPolicy =
      config.crawlOptions?.check_robots_txt === false ? 'ignore' : 'respect';
    definition.settings.domainScope =
      config.hostScope === 'strict_hosts'
        ? 'strict_hosts'
        : 'registrable_domain';

    const seedNode = definition.nodes.find(
      (node) => node.type === CrawlStrategyWorkflowNodeType.SeedDiscovery,
    );
    if (seedNode) {
      seedNode.config = {
        ...seedNode.config,
        mode: config.seedDiscovery?.mode === 'disabled' ? 'sitemap' : 'sitemap',
        maxUrls: config.seedDiscovery?.maxSeedUrls ?? 40,
      };
    }

    const filterNode = definition.nodes.find(
      (node) => node.type === CrawlStrategyWorkflowNodeType.UrlFilter,
    );
    if (filterNode) {
      filterNode.config = {
        includePatterns: config.urlPatterns?.article ?? [],
        excludePatterns: config.urlPatterns?.exclude ?? [],
        blockedDomains: config.blockedDomains ?? [],
        allowedHosts: config.allowedHosts ?? [],
        denyKeywords: config.denyKeywords ?? [],
      };
    }

    const classifierNode = definition.nodes.find(
      (node) => node.type === CrawlStrategyWorkflowNodeType.PageTypeClassifier,
    );
    if (classifierNode) {
      classifierNode.config = {
        urlPatterns: config.urlPatterns ?? {},
        pageTypeSignals: config.pageTypeSignals ?? {},
      };
    }

    const scorerNode = definition.nodes.find(
      (node) => node.type === CrawlStrategyWorkflowNodeType.UrlScorer,
    );
    if (scorerNode) {
      scorerNode.config = {
        keywordBoosts: [
          ...(config.keywords ?? []),
          ...(config.priorityKeywords ?? []),
        ],
      };
    }

    const freshnessNode = definition.nodes.find(
      (node) => node.type === CrawlStrategyWorkflowNodeType.FreshnessScorer,
    );
    if (freshnessNode) {
      freshnessNode.config = {
        recentHours: config.freshnessRules?.recentHours ?? 24,
        weekHours: config.freshnessRules?.weekHours ?? 24 * 7,
        monthHours: config.freshnessRules?.monthHours ?? 24 * 30,
      };
    }

    const budgetNode = definition.nodes.find(
      (node) => node.type === CrawlStrategyWorkflowNodeType.BudgetControl,
    );
    if (budgetNode) {
      budgetNode.config = {
        keepTopK: config.layeredOptions?.maxPages ?? 20,
        minScore: config.layeredOptions?.scoreThreshold ?? 0,
        maxPages: config.layeredOptions?.maxPages ?? 60,
        maxDepth: config.layeredOptions?.maxDepth ?? 3,
      };
    }

    const persistNode = definition.nodes.find(
      (node) => node.type === CrawlStrategyWorkflowNodeType.PersistResult,
    );
    if (persistNode) {
      persistNode.config = {
        selectTopK: config.layeredOptions?.maxPages ?? 20,
      };
    }

    return definition;
  }

  buildWorkflowFromNewsSource(
    source: LegacyNewsSourceInput,
  ): CrawlStrategyWorkflowDefinition {
    const definition = createEmptyWorkflowDefinition(source.url);
    definition.metadata.template = 'legacy_news_source';
    definition.metadata.description = `Generated from news source ${source.url}`;

    const config = isRecord(source.config) ? source.config : {};
    const seed = isRecord(config.seed) ? config.seed : null;
    const crawlOptions = isRecord(source.crawlOptions)
      ? source.crawlOptions
      : undefined;
    const keywords = Array.isArray(config.keywords)
      ? config.keywords
          .filter((entry): entry is string => typeof entry === 'string')
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0)
      : [];

    if (!seed || seed.enabled !== true) {
      return definition;
    }

    const modeRaw =
      typeof seed.mode === 'string' ? seed.mode.trim().toLowerCase() : '';
    const discoveryType =
      modeRaw === 'list'
        ? CrawlStrategyWorkflowNodeType.ListDiscovery
        : modeRaw === 'deep'
          ? CrawlStrategyWorkflowNodeType.DeepDiscovery
          : CrawlStrategyWorkflowNodeType.SeedDiscovery;

    definition.nodes = definition.nodes.map((node) => {
      if (node.id !== 'seed-discovery') {
        return node;
      }
      if (discoveryType === CrawlStrategyWorkflowNodeType.ListDiscovery) {
        return {
          ...node,
          type: CrawlStrategyWorkflowNodeType.ListDiscovery,
          label: 'List Discovery',
          config: {
            listUrl: source.url,
            domain: typeof seed.domain === 'string' ? seed.domain : '',
            pattern: typeof seed.pattern === 'string' ? seed.pattern : '',
            maxUrls:
              typeof seed.maxUrls === 'number' && Number.isFinite(seed.maxUrls)
                ? seed.maxUrls
                : 80,
            listMaxPages:
              typeof seed.listMaxPages === 'number' &&
              Number.isFinite(seed.listMaxPages)
                ? seed.listMaxPages
                : 6,
            listPageConcurrency:
              typeof seed.listPageConcurrency === 'number' &&
              Number.isFinite(seed.listPageConcurrency)
                ? seed.listPageConcurrency
                : 2,
            followPagination: seed.followPagination !== false,
            crawlOptions: crawlOptions ?? {},
          },
        };
      }
      if (discoveryType === CrawlStrategyWorkflowNodeType.DeepDiscovery) {
        return {
          ...node,
          type: CrawlStrategyWorkflowNodeType.DeepDiscovery,
          label: 'Deep Discovery',
          config: {
            seedUrl: source.url,
            domain: typeof seed.domain === 'string' ? seed.domain : '',
            pattern: typeof seed.pattern === 'string' ? seed.pattern : '',
            query: typeof seed.query === 'string' ? seed.query : keywords.join(' '),
            maxUrls:
              typeof seed.maxUrls === 'number' && Number.isFinite(seed.maxUrls)
                ? seed.maxUrls
                : 80,
            deep: isRecord(seed.deep) ? seed.deep : {},
            crawlOptions: crawlOptions ?? {},
          },
        };
      }
      return {
        ...node,
        type: CrawlStrategyWorkflowNodeType.SeedDiscovery,
        label: 'Seed Discovery',
        config: {
          mode: modeRaw === 'rss' ? 'rss' : 'sitemap',
          seedUrl: source.url,
          domain: typeof seed.domain === 'string' ? seed.domain : '',
          pattern: typeof seed.pattern === 'string' ? seed.pattern : '',
          feedUrl: typeof seed.feedUrl === 'string' ? seed.feedUrl : '',
          maxUrls:
            typeof seed.maxUrls === 'number' && Number.isFinite(seed.maxUrls)
              ? seed.maxUrls
              : 80,
        },
      };
    });

    const filterNode = definition.nodes.find(
      (node) => node.type === CrawlStrategyWorkflowNodeType.UrlFilter,
    );
    if (filterNode) {
      filterNode.config = {
        includePatterns: [],
        excludePatterns: [],
        blockedDomains: [],
        allowedHosts: [],
        denyKeywords: [],
      };
    }

    const scorerNode = definition.nodes.find(
      (node) => node.type === CrawlStrategyWorkflowNodeType.UrlScorer,
    );
    if (scorerNode) {
      scorerNode.config = {
        keywordBoosts: keywords,
      };
    }

    const budgetNode = definition.nodes.find(
      (node) => node.type === CrawlStrategyWorkflowNodeType.BudgetControl,
    );
    if (budgetNode) {
      budgetNode.config = {
        keepTopK:
          typeof seed.maxNewUrlsPerRun === 'number' &&
          Number.isFinite(seed.maxNewUrlsPerRun)
            ? seed.maxNewUrlsPerRun
            : 20,
        minScore:
          typeof seed.scoreThreshold === 'number' &&
          Number.isFinite(seed.scoreThreshold)
            ? seed.scoreThreshold
            : 0,
        maxPages:
          typeof seed.maxUrls === 'number' && Number.isFinite(seed.maxUrls)
            ? seed.maxUrls
            : 60,
        maxDepth:
          isRecord(seed.deep) &&
          typeof seed.deep.maxDepth === 'number' &&
          Number.isFinite(seed.deep.maxDepth)
            ? seed.deep.maxDepth
            : 3,
      };
    }

    return definition;
  }

  mergeProfileConfigPatch(
    base: CrawlSiteProfileConfig,
    patch: Partial<CrawlSiteProfileConfig>,
  ): CrawlSiteProfileConfig {
    return normalizeCrawlSiteProfileConfig({
      ...base,
      ...patch,
      urlPatterns: {
        ...(base.urlPatterns ?? {}),
        ...(patch.urlPatterns ?? {}),
      },
      pageTypeSignals: {
        ...(base.pageTypeSignals ?? {}),
        ...(patch.pageTypeSignals ?? {}),
      },
      freshnessRules: {
        ...(base.freshnessRules ?? {}),
        ...(patch.freshnessRules ?? {}),
      },
      layeredOptions: {
        ...(base.layeredOptions ?? {}),
        ...(patch.layeredOptions ?? {}),
      },
      crawlOptions: {
        ...(base.crawlOptions ?? {}),
        ...(patch.crawlOptions ?? {}),
      },
    });
  }

  resolveExecutionMode(
    current: CrawlSiteExecutionMode,
    next?: CrawlSiteExecutionMode,
  ) {
    return next ?? current;
  }
}
