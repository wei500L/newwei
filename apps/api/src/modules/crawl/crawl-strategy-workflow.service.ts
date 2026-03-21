import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { toPrismaJsonValue } from '../../common/prisma-json';
import { PrismaService } from '../config/prisma.service';

import { normalizeCrawlSiteProfileConfig } from './crawl-frontier.utils';
import { CrawlStrategyLegacyBridgeService } from './crawl-strategy-legacy-bridge.service';
import {
  CRAWL_STRATEGY_NODE_SCHEMAS,
  getCrawlStrategyNodeSchema,
} from './crawl-strategy.registry';
import {
  createEmptyWorkflowDefinition,
  isRecord,
  CrawlStrategyWorkflowNodeType,
  type CrawlStrategyCompiledNewsSourceOverlay,
  type CrawlStrategyCompiledProfileOverlay,
  type CrawlStrategyParameterSource,
  type CrawlStrategyWorkflowDefinition,
} from './crawl-strategy.types';
import type {
  CrawlSiteExecutionMode,
  CrawlSiteProfileConfig,
  CrawlSiteProfileRecord,
} from './crawl.types';
import type {
  CompareCrawlStrategyWorkflowVersionsDto,
  CreateCrawlStrategyWorkflowDto,
  ListCrawlStrategyWorkflowDto,
  PublishCrawlStrategyWorkflowDto,
  UpdateCrawlStrategyWorkflowDraftDto,
} from './dto/crawl-strategy.dto';

type WorkflowRecord = Prisma.CrawlStrategyWorkflowGetPayload<{
  include: {
    publishedVersion: true;
    versions: {
      orderBy: [{ version: 'desc' }];
      take: 10;
    };
  };
}>;

interface WorkflowSummary {
  workflowId: string;
  workflowVersionId: string;
  workflowName: string;
  version: number;
}

@Injectable()
export class CrawlStrategyWorkflowService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly legacyBridge: CrawlStrategyLegacyBridgeService,
  ) {}

  listNodeSchemas() {
    return CRAWL_STRATEGY_NODE_SCHEMAS;
  }

  async listWorkflows(orgId: string, query?: ListCrawlStrategyWorkflowDto) {
    const where: Prisma.CrawlStrategyWorkflowWhereInput = { orgId };
    const search = query?.search?.trim();
    if (search) {
      where.OR = [
        { name: { contains: search } },
        { description: { contains: search } },
      ];
    }
    const items = await this.prisma.crawlStrategyWorkflow.findMany({
      where,
      include: {
        publishedVersion: true,
        versions: {
          orderBy: [{ version: 'desc' }],
          take: 10,
        },
      },
      orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }],
    });
    return items.map((item) => this.mapWorkflow(item));
  }

  async getWorkflow(orgId: string, id: string) {
    const workflow = await this.prisma.crawlStrategyWorkflow.findUnique({
      where: { id },
      include: {
        publishedVersion: true,
        versions: {
          orderBy: [{ version: 'desc' }],
          take: 10,
        },
      },
    });
    if (!workflow || workflow.orgId !== orgId) {
      throw new NotFoundException('Workflow not found');
    }
    return this.mapWorkflow(workflow);
  }

  async createWorkflow(
    orgId: string,
    actorId: string,
    input: CreateCrawlStrategyWorkflowDto,
  ) {
    const name = input.name.trim();
    if (!name) {
      throw new BadRequestException('name is required');
    }
    const definition = this.normalizeWorkflowDefinition(input.draftDefinition);
    const created = await this.prisma.crawlStrategyWorkflow.create({
      data: {
        orgId,
        name,
        description: this.normalizeOptionalString(input.description),
        draftDefinition: toPrismaJsonValue(definition),
        createdById: actorId,
        updatedById: actorId,
      },
      include: {
        publishedVersion: true,
        versions: {
          orderBy: [{ version: 'desc' }],
          take: 10,
        },
      },
    });
    return this.mapWorkflow(created);
  }

  async updateDraft(
    orgId: string,
    actorId: string,
    id: string,
    input: UpdateCrawlStrategyWorkflowDraftDto,
  ) {
    const existing = await this.ensureWorkflow(orgId, id);
    const updated = await this.prisma.crawlStrategyWorkflow.update({
      where: { id: existing.id },
      data: {
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.description !== undefined
          ? { description: this.normalizeOptionalString(input.description) }
          : {}),
        draftDefinition: toPrismaJsonValue(
          this.normalizeWorkflowDefinition(input.draftDefinition),
        ),
        updatedById: actorId,
      },
      include: {
        publishedVersion: true,
        versions: {
          orderBy: [{ version: 'desc' }],
          take: 10,
        },
      },
    });
    return this.mapWorkflow(updated);
  }

  async publishWorkflow(
    orgId: string,
    actorId: string,
    id: string,
    input?: PublishCrawlStrategyWorkflowDto,
  ) {
    const workflow = await this.ensureWorkflow(orgId, id);
    const currentMaxVersion =
      workflow.versions.length > 0
        ? Math.max(...workflow.versions.map((entry) => entry.version))
        : 0;
    const nextVersion = currentMaxVersion + 1;
    const versionName =
      input?.versionName?.trim().length
        ? input.versionName.trim()
        : workflow.name;
    const description =
      input?.description !== undefined
        ? this.normalizeOptionalString(input.description)
        : workflow.description;
    const definition = this.normalizeWorkflowDefinition(workflow.draftDefinition);

    const published = await this.prisma.$transaction(async (tx) => {
      const version = await tx.crawlStrategyWorkflowVersion.create({
        data: {
          workflowId: workflow.id,
          orgId,
          version: nextVersion,
          name: versionName,
          description,
          definition: toPrismaJsonValue(definition),
          createdById: actorId,
        },
      });
      const updatedWorkflow = await tx.crawlStrategyWorkflow.update({
        where: { id: workflow.id },
        data: {
          description,
          publishedVersionId: version.id,
          updatedById: actorId,
        },
        include: {
          publishedVersion: true,
          versions: {
            orderBy: [{ version: 'desc' }],
            take: 10,
          },
        },
      });
      return { version, workflow: updatedWorkflow };
    });

    return {
      workflow: this.mapWorkflow(published.workflow),
      version: this.mapWorkflowVersion(published.version),
    };
  }

  async listVersions(orgId: string, workflowId: string) {
    await this.ensureWorkflow(orgId, workflowId);
    const versions = await this.prisma.crawlStrategyWorkflowVersion.findMany({
      where: { orgId, workflowId },
      orderBy: [{ version: 'desc' }, { createdAt: 'desc' }],
    });
    return versions.map((version) => this.mapWorkflowVersion(version));
  }

  async getVersion(orgId: string, versionId: string) {
    const version = await this.prisma.crawlStrategyWorkflowVersion.findUnique({
      where: { id: versionId },
    });
    if (!version || version.orgId !== orgId) {
      throw new NotFoundException('Workflow version not found');
    }
    return this.mapWorkflowVersion(version);
  }

  async compareVersions(
    orgId: string,
    input: CompareCrawlStrategyWorkflowVersionsDto,
  ) {
    const [left, right] = await Promise.all([
      this.getVersion(orgId, input.leftVersionId),
      this.getVersion(orgId, input.rightVersionId),
    ]);
    const settingsDiff = this.buildSettingsDiff(
      left.definition.settings as unknown as Record<string, unknown>,
      right.definition.settings as unknown as Record<string, unknown>,
    );
    const nodesDiff = this.buildNodeDiff(left.definition.nodes, right.definition.nodes);
    const edgesDiff = this.buildEdgeDiff(left.definition.edges, right.definition.edges);
    const bindingImpact = await this.buildBindingImpact(orgId, {
      leftWorkflowId: left.workflowId,
      rightWorkflowId: right.workflowId,
      leftVersionId: left.id,
      rightVersionId: right.id,
    });
    return {
      left,
      right,
      summary: {
        nodeCountDelta:
          right.definition.nodes.length - left.definition.nodes.length,
        edgeCountDelta:
          right.definition.edges.length - left.definition.edges.length,
        changedSettingsCount: settingsDiff.length,
        addedNodeCount: nodesDiff.added.length,
        removedNodeCount: nodesDiff.removed.length,
        changedNodeCount: nodesDiff.changed.length,
        addedEdgeCount: edgesDiff.added.length,
        removedEdgeCount: edgesDiff.removed.length,
      },
      definitionDiff: {
        leftSettings: left.definition.settings,
        rightSettings: right.definition.settings,
        leftNodeIds: left.definition.nodes.map((node) => node.id),
        rightNodeIds: right.definition.nodes.map((node) => node.id),
        settings: settingsDiff,
        nodes: nodesDiff,
        edges: edgesDiff,
      },
      bindingImpact,
    };
  }

  async buildLegacyProfileBridge(orgId: string, profileId: string, seedUrl?: string) {
    const profile = await this.prisma.crawlSiteProfile.findUnique({
      where: { id: profileId },
    });
    if (!profile || profile.orgId !== orgId) {
      throw new NotFoundException('Crawl site profile not found');
    }
    return this.legacyBridge.buildWorkflowFromProfile(
      {
        ...profile,
        config: normalizeCrawlSiteProfileConfig(profile.config),
      } as CrawlSiteProfileRecord,
      seedUrl,
    );
  }

  buildLegacyProfileDefinition(
    profile: Pick<
      CrawlSiteProfileRecord,
      'name' | 'description' | 'executionMode' | 'config'
    >,
    seedUrl?: string,
  ) {
    return this.legacyBridge.buildWorkflowFromProfile(profile, seedUrl);
  }

  async buildLegacyNewsSourceBridge(orgId: string, sourceId: string) {
    const source = await this.prisma.newsSource.findUnique({
      where: { id: sourceId },
      include: {
        crawlTemplate: {
          select: { id: true, isActive: true, crawlOptions: true },
        },
      },
    });
    if (!source || source.orgId !== orgId) {
      throw new NotFoundException('News source not found');
    }
    return this.legacyBridge.buildWorkflowFromNewsSource({
      url: source.url,
      config: isRecord(source.config) ? source.config : null,
      crawlOptions:
        source.crawlTemplate?.isActive && isRecord(source.crawlTemplate.crawlOptions)
          ? source.crawlTemplate.crawlOptions
          : null,
    });
  }

  buildLegacyNewsSourceDefinition(input: {
    url: string;
    config?: Record<string, unknown> | null;
    crawlOptions?: Record<string, unknown> | null;
  }) {
    return this.legacyBridge.buildWorkflowFromNewsSource(input);
  }

  async resolveBoundWorkflowVersion(options: {
    orgId: string;
    workflowId?: string | null;
    workflowVersionId?: string | null;
    workflowBindingMode?: string | null;
  }) {
    const workflowVersionId = options.workflowVersionId?.trim() || null;
    if (workflowVersionId) {
      const version = await this.prisma.crawlStrategyWorkflowVersion.findUnique({
        where: { id: workflowVersionId },
        include: {
          workflow: true,
        },
      });
      if (!version || version.orgId !== options.orgId) {
        throw new NotFoundException('Workflow version not found');
      }
      return {
        workflow: version.workflow,
        version,
        definition: this.normalizeWorkflowDefinition(version.definition),
      };
    }

    const workflowId = options.workflowId?.trim() || null;
    if (!workflowId) {
      return null;
    }
    const workflow = await this.prisma.crawlStrategyWorkflow.findUnique({
      where: { id: workflowId },
      include: {
        publishedVersion: true,
      },
    });
    if (!workflow || workflow.orgId !== options.orgId) {
      throw new NotFoundException('Workflow not found');
    }
    if (!workflow.publishedVersion) {
      throw new BadRequestException('Workflow has no published version');
    }
    return {
      workflow,
      version: workflow.publishedVersion,
      definition: this.normalizeWorkflowDefinition(
        workflow.publishedVersion.definition,
      ),
    };
  }

  async compileProfileOverlay(options: {
    orgId: string;
    baseExecutionMode: CrawlSiteExecutionMode;
    baseConfig: CrawlSiteProfileConfig;
    workflowId?: string | null;
    workflowVersionId?: string | null;
    workflowBindingMode?: string | null;
  }): Promise<CrawlStrategyCompiledProfileOverlay | null> {
    const resolved = await this.resolveBoundWorkflowVersion(options);
    if (!resolved) {
      return null;
    }
    const definition = resolved.definition;
    const configPatch: Partial<CrawlSiteProfileConfig> = {};
    const parameterSources: CrawlStrategyParameterSource[] = [];

    configPatch.hostScope =
      definition.settings.domainScope === 'strict_hosts'
        ? 'strict_hosts'
        : 'registrable_domain';
    parameterSources.push({
      key: 'settings.domainScope',
      value: definition.settings.domainScope,
      source: 'workflow',
    });

    configPatch.crawlOptions = {
      check_robots_txt: definition.settings.robotsPolicy === 'respect',
    };
    parameterSources.push({
      key: 'settings.robotsPolicy',
      value: definition.settings.robotsPolicy,
      source: 'workflow',
    });

    configPatch.layeredOptions = {
      ...(options.baseConfig.layeredOptions ?? {}),
      maxDepth: definition.settings.maxDepth,
      maxPages: definition.settings.maxPages,
    };

    for (const node of definition.nodes) {
      switch (node.type) {
        case CrawlStrategyWorkflowNodeType.UrlFilter: {
          configPatch.blockedDomains = this.toStringArray(
            node.config.blockedDomains,
          );
          configPatch.allowedHosts = this.toStringArray(node.config.allowedHosts);
          configPatch.denyKeywords = this.toStringArray(node.config.denyKeywords);
          configPatch.urlPatterns = {
            ...(configPatch.urlPatterns ?? {}),
            exclude: this.toStringArray(node.config.excludePatterns),
            article: this.toStringArray(node.config.includePatterns),
          };
          parameterSources.push({
            key: `nodes.${node.id}`,
            value: node.config,
            source: 'workflow',
          });
          break;
        }
        case CrawlStrategyWorkflowNodeType.PageTypeClassifier: {
          if (isRecord(node.config.urlPatterns)) {
            configPatch.urlPatterns = {
              ...(configPatch.urlPatterns ?? {}),
              ...(node.config.urlPatterns as Record<string, string[]>),
            };
          }
          if (isRecord(node.config.pageTypeSignals)) {
            configPatch.pageTypeSignals = {
              ...(configPatch.pageTypeSignals ?? {}),
              ...(node.config.pageTypeSignals as Record<string, unknown>),
            };
          }
          break;
        }
        case CrawlStrategyWorkflowNodeType.UrlScorer: {
          const keywords = this.toStringArray(node.config.keywordBoosts);
          configPatch.keywords = keywords;
          configPatch.priorityKeywords = keywords;
          parameterSources.push({
            key: `nodes.${node.id}.keywordBoosts`,
            value: keywords,
            source: 'workflow',
          });
          break;
        }
        case CrawlStrategyWorkflowNodeType.FreshnessScorer: {
          configPatch.freshnessRules = {
            recentHours: this.toNumber(node.config.recentHours, 24),
            weekHours: this.toNumber(node.config.weekHours, 24 * 7),
            monthHours: this.toNumber(node.config.monthHours, 24 * 30),
          };
          parameterSources.push({
            key: `nodes.${node.id}`,
            value: configPatch.freshnessRules,
            source: 'workflow',
          });
          break;
        }
        case CrawlStrategyWorkflowNodeType.BudgetControl: {
          configPatch.layeredOptions = {
            ...(configPatch.layeredOptions ?? {}),
            scoreThreshold: this.toNumber(node.config.minScore, 0),
            maxPages: this.toNumber(
              node.config.maxPages,
              definition.settings.maxPages,
            ),
            maxDepth: this.toNumber(
              node.config.maxDepth,
              definition.settings.maxDepth,
            ),
          };
          parameterSources.push({
            key: `nodes.${node.id}`,
            value: node.config,
            source: 'workflow',
          });
          break;
        }
        case CrawlStrategyWorkflowNodeType.DeepDiscovery: {
          configPatch.seedDiscovery = {
            ...(configPatch.seedDiscovery ?? {}),
            maxSeedUrls: this.toNumber(node.config.maxUrls, 60),
          };
          configPatch.nativeOptions = {
            ...(options.baseConfig.nativeOptions ?? {}),
            fallbackToLayered: true,
          };
          break;
        }
        default:
          break;
      }
    }

    return {
      executionMode: definition.settings.executionMode,
      configPatch,
      parameterSources,
      workflowSummary: {
        workflowId: resolved.workflow.id,
        workflowVersionId: resolved.version.id,
        workflowName: resolved.workflow.name,
        version: resolved.version.version,
      },
    };
  }

  async compileNewsSourceOverlay(options: {
    orgId: string;
    workflowId?: string | null;
    workflowVersionId?: string | null;
    workflowBindingMode?: string | null;
  }): Promise<CrawlStrategyCompiledNewsSourceOverlay | null> {
    const resolved = await this.resolveBoundWorkflowVersion(options);
    if (!resolved) {
      return null;
    }
    const definition = resolved.definition;
    const seed: Record<string, unknown> = {
      enabled: true,
    };
    const crawlOptions: Record<string, unknown> = {
      check_robots_txt: definition.settings.robotsPolicy === 'respect',
    };
    const parameterSources: CrawlStrategyParameterSource[] = [
      {
        key: 'settings.robotsPolicy',
        value: definition.settings.robotsPolicy,
        source: 'workflow',
      },
    ];
    let keywords: string[] = [];

    for (const node of definition.nodes) {
      switch (node.type) {
        case CrawlStrategyWorkflowNodeType.SeedDiscovery: {
          seed.mode = node.config.mode === 'rss' ? 'rss' : 'sitemap';
          seed.domain = this.toString(node.config.domain);
          seed.pattern = this.toString(node.config.pattern);
          seed.feedUrl = this.toString(node.config.feedUrl);
          seed.maxUrls = this.toNumber(node.config.maxUrls, 40);
          break;
        }
        case CrawlStrategyWorkflowNodeType.ListDiscovery: {
          seed.mode = 'list';
          seed.domain = this.toString(node.config.domain);
          seed.pattern = this.toString(node.config.pattern);
          seed.maxUrls = this.toNumber(node.config.maxUrls, 60);
          seed.listMaxPages = this.toNumber(node.config.listMaxPages, 6);
          seed.listPageConcurrency = this.toNumber(
            node.config.listPageConcurrency,
            2,
          );
          seed.followPagination = node.config.followPagination !== false;
          break;
        }
        case CrawlStrategyWorkflowNodeType.DeepDiscovery: {
          seed.mode = 'deep';
          seed.domain = this.toString(node.config.domain);
          seed.pattern = this.toString(node.config.pattern);
          seed.query = this.toString(node.config.query);
          seed.maxUrls = this.toNumber(node.config.maxUrls, 60);
          seed.deep = isRecord(node.config.deep) ? node.config.deep : {};
          break;
        }
        case CrawlStrategyWorkflowNodeType.UrlScorer: {
          keywords = this.toStringArray(node.config.keywordBoosts);
          break;
        }
        case CrawlStrategyWorkflowNodeType.BudgetControl: {
          seed.maxNewUrlsPerRun = this.toNumber(node.config.keepTopK, 20);
          seed.scoreThreshold = this.toNumber(node.config.minScore, 0);
          break;
        }
        default:
          break;
      }
    }

    parameterSources.push({
      key: 'nodes',
      value: definition.nodes.map((node) => ({
        id: node.id,
        type: node.type,
      })),
      source: 'workflow',
    });

    return {
      crawlOptions,
      seed,
      keywords,
      parameterSources,
      workflowSummary: {
        workflowId: resolved.workflow.id,
        workflowVersionId: resolved.version.id,
        workflowName: resolved.workflow.name,
        version: resolved.version.version,
      },
    };
  }

  applyProfileOverlay(options: {
    profile: CrawlSiteProfileRecord;
    overlay: CrawlStrategyCompiledProfileOverlay | null;
  }): CrawlSiteProfileRecord {
    if (!options.overlay) {
      return options.profile;
    }
    return {
      ...options.profile,
      executionMode: this.legacyBridge.resolveExecutionMode(
        options.profile.executionMode,
        options.overlay.executionMode,
      ),
      config: this.legacyBridge.mergeProfileConfigPatch(
        options.profile.config,
        options.overlay.configPatch,
      ),
    };
  }

  private async ensureWorkflow(orgId: string, id: string) {
    const workflow = await this.prisma.crawlStrategyWorkflow.findUnique({
      where: { id },
      include: {
        publishedVersion: true,
        versions: {
          orderBy: [{ version: 'desc' }],
          take: 50,
        },
      },
    });
    if (!workflow || workflow.orgId !== orgId) {
      throw new NotFoundException('Workflow not found');
    }
    return workflow;
  }

  private normalizeWorkflowDefinition(
    value?: Record<string, unknown> | Prisma.JsonValue | null,
  ): CrawlStrategyWorkflowDefinition {
    if (!isRecord(value)) {
      return createEmptyWorkflowDefinition();
    }

    const base = createEmptyWorkflowDefinition();
    const settings = isRecord(value.settings) ? value.settings : {};
    const nodes = Array.isArray(value.nodes)
      ? value.nodes
          .filter((entry): entry is Record<string, unknown> => isRecord(entry))
          .map((entry, index) => {
            const schema = getCrawlStrategyNodeSchema(String(entry.type ?? ''));
            const baseNode = base.nodes[index];
            return {
              id:
                typeof entry.id === 'string' && entry.id.trim().length > 0
                  ? entry.id.trim()
                  : `${schema?.type ?? baseNode?.type ?? 'node'}-${index + 1}`,
              type:
                schema?.type ??
                baseNode?.type ??
                CrawlStrategyWorkflowNodeType.SeedDiscovery,
              label:
                typeof entry.label === 'string' && entry.label.trim().length > 0
                  ? entry.label.trim()
                  : schema?.defaultLabel ?? `Node ${index + 1}`,
              position: isRecord(entry.position)
                ? {
                    x: this.toNumber(entry.position.x, 0),
                    y: this.toNumber(entry.position.y, 0),
                  }
                : { x: index * 240, y: 120 },
              config: isRecord(entry.config) ? entry.config : {},
              uiState: isRecord(entry.uiState) ? entry.uiState : undefined,
            };
          })
      : base.nodes;
    const edges = Array.isArray(value.edges)
      ? value.edges
          .filter((entry): entry is Record<string, unknown> => isRecord(entry))
          .map((entry, index) => ({
            id:
              typeof entry.id === 'string' && entry.id.trim().length > 0
                ? entry.id.trim()
                : `edge-${index + 1}`,
            source: this.toString(entry.source) ?? '',
            target: this.toString(entry.target) ?? '',
            sourceHandle: this.toString(entry.sourceHandle),
            targetHandle: this.toString(entry.targetHandle),
            condition: this.toString(entry.condition),
            priority:
              typeof entry.priority === 'number' && Number.isFinite(entry.priority)
                ? entry.priority
                : undefined,
          }))
          .filter((entry) => entry.source.length > 0 && entry.target.length > 0)
      : base.edges;

    return {
      version: 1,
      metadata: {
        description: this.toString(value.metadata && isRecord(value.metadata) ? value.metadata.description : undefined) ?? base.metadata.description,
        template: this.toString(value.metadata && isRecord(value.metadata) ? value.metadata.template : undefined) ?? base.metadata.template,
        tags:
          value.metadata && isRecord(value.metadata)
            ? this.toStringArray(value.metadata.tags)
            : base.metadata.tags,
      },
      settings: {
        executionMode: this.normalizeExecutionMode(settings.executionMode),
        maxDepth: this.toNumber(settings.maxDepth, base.settings.maxDepth),
        maxPages: this.toNumber(settings.maxPages, base.settings.maxPages),
        timeoutMs: this.toNumber(settings.timeoutMs, base.settings.timeoutMs),
        concurrency: this.toNumber(
          settings.concurrency,
          base.settings.concurrency,
        ),
        robotsPolicy:
          this.toString(settings.robotsPolicy) === 'ignore'
            ? 'ignore'
            : 'respect',
        domainScope:
          this.toString(settings.domainScope) === 'strict_hosts'
            ? 'strict_hosts'
            : this.toString(settings.domainScope) === 'inherit_profile'
              ? 'inherit_profile'
              : 'registrable_domain',
      },
      nodes,
      edges,
    };
  }

  private normalizeExecutionMode(value: unknown): CrawlSiteExecutionMode {
    return value === 'layered' || value === 'native' || value === 'hybrid'
      ? value
      : 'hybrid';
  }

  private mapWorkflow(record: WorkflowRecord) {
    return {
      id: record.id,
      orgId: record.orgId,
      name: record.name,
      description: record.description,
      draftDefinition: this.normalizeWorkflowDefinition(record.draftDefinition),
      publishedVersionId: record.publishedVersionId,
      publishedVersion: record.publishedVersion
        ? this.mapWorkflowVersion(record.publishedVersion)
        : null,
      versions: record.versions.map((version) => this.mapWorkflowVersion(version)),
      createdById: record.createdById,
      updatedById: record.updatedById,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  private mapWorkflowVersion(
    version: {
      id: string;
      workflowId: string;
      orgId: string;
      version: number;
      name: string;
      description: string | null;
      definition: Prisma.JsonValue;
      createdById: string;
      createdAt: Date;
    },
  ) {
    return {
      id: version.id,
      workflowId: version.workflowId,
      orgId: version.orgId,
      version: version.version,
      name: version.name,
      description: version.description,
      definition: this.normalizeWorkflowDefinition(version.definition),
      createdById: version.createdById,
      createdAt: version.createdAt,
    };
  }

  private normalizeOptionalString(value?: string | null) {
    if (value === undefined) {
      return undefined;
    }
    if (value === null) {
      return null;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private toNumber(value: unknown, fallback: number) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return fallback;
    }
    return value;
  }

  private toString(value: unknown) {
    return typeof value === 'string' && value.trim().length > 0
      ? value.trim()
      : undefined;
  }

  private toStringArray(value: unknown) {
    if (!Array.isArray(value)) {
      return [];
    }
    return value
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }

  private buildSettingsDiff(
    left: Record<string, unknown>,
    right: Record<string, unknown>,
  ) {
    return Array.from(new Set([...Object.keys(left), ...Object.keys(right)]))
      .sort()
      .filter((key) => JSON.stringify(left[key]) !== JSON.stringify(right[key]))
      .map((key) => ({
        key,
        left: left[key] ?? null,
        right: right[key] ?? null,
      }));
  }

  private buildNodeDiff(
    leftNodes: CrawlStrategyWorkflowDefinition['nodes'],
    rightNodes: CrawlStrategyWorkflowDefinition['nodes'],
  ) {
    const leftById = new Map(leftNodes.map((node) => [node.id, node]));
    const rightById = new Map(rightNodes.map((node) => [node.id, node]));
    const added = rightNodes.filter((node) => !leftById.has(node.id));
    const removed = leftNodes.filter((node) => !rightById.has(node.id));
    const changed = leftNodes
      .filter((node) => rightById.has(node.id))
      .map((node) => {
        const next = rightById.get(node.id)!;
        const changedFields = [
          JSON.stringify(node.type) !== JSON.stringify(next.type) ? 'type' : null,
          JSON.stringify(node.label) !== JSON.stringify(next.label) ? 'label' : null,
          JSON.stringify(node.position) !== JSON.stringify(next.position)
            ? 'position'
            : null,
          JSON.stringify(node.config) !== JSON.stringify(next.config) ? 'config' : null,
          JSON.stringify(node.uiState ?? null) !== JSON.stringify(next.uiState ?? null)
            ? 'uiState'
            : null,
        ].filter((field): field is string => Boolean(field));
        if (changedFields.length === 0) {
          return null;
        }
        return {
          id: node.id,
          left: node,
          right: next,
          changedFields,
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
    return {
      added,
      removed,
      changed,
    };
  }

  private buildEdgeDiff(
    leftEdges: CrawlStrategyWorkflowDefinition['edges'],
    rightEdges: CrawlStrategyWorkflowDefinition['edges'],
  ) {
    const leftBySignature = new Map(
      leftEdges.map((edge) => [this.buildEdgeSignature(edge), edge]),
    );
    const rightBySignature = new Map(
      rightEdges.map((edge) => [this.buildEdgeSignature(edge), edge]),
    );
    const added = rightEdges.filter(
      (edge) => !leftBySignature.has(this.buildEdgeSignature(edge)),
    );
    const removed = leftEdges.filter(
      (edge) => !rightBySignature.has(this.buildEdgeSignature(edge)),
    );
    return {
      added,
      removed,
    };
  }

  private buildEdgeSignature(
    edge: CrawlStrategyWorkflowDefinition['edges'][number],
  ) {
    return JSON.stringify({
      source: edge.source,
      target: edge.target,
      sourceHandle: edge.sourceHandle ?? null,
      targetHandle: edge.targetHandle ?? null,
      condition: edge.condition ?? null,
      priority: edge.priority ?? null,
    });
  }

  private async buildBindingImpact(
    orgId: string,
    options: {
      leftWorkflowId: string;
      rightWorkflowId: string;
      leftVersionId: string;
      rightVersionId: string;
    },
  ) {
    const workflowIds = Array.from(
      new Set([options.leftWorkflowId, options.rightWorkflowId].filter(Boolean)),
    );
    const versionIds = Array.from(
      new Set([options.leftVersionId, options.rightVersionId].filter(Boolean)),
    );
    const [workflows, profiles, newsSources] = await Promise.all([
      this.prisma.crawlStrategyWorkflow.findMany({
        where: {
          orgId,
          id: { in: workflowIds },
        },
        select: {
          id: true,
          name: true,
          publishedVersionId: true,
        },
      }),
      this.prisma.crawlSiteProfile.findMany({
        where: {
          orgId,
          OR: [
            { workflowId: { in: workflowIds } },
            { workflowVersionId: { in: versionIds } },
          ],
        },
        select: {
          id: true,
          name: true,
          matchHost: true,
          workflowId: true,
          workflowVersionId: true,
          workflowBindingMode: true,
          updatedAt: true,
        },
        orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }],
      }),
      this.prisma.newsSource.findMany({
        where: {
          orgId,
          OR: [
            { workflowId: { in: workflowIds } },
            { workflowVersionId: { in: versionIds } },
          ],
        },
        select: {
          id: true,
          name: true,
          url: true,
          workflowId: true,
          workflowVersionId: true,
          workflowBindingMode: true,
          updatedAt: true,
        },
        orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }],
      }),
    ]);
    const workflowById = new Map(workflows.map((workflow) => [workflow.id, workflow]));
    const classifyUsage = (
      workflowId?: string | null,
      workflowVersionId?: string | null,
    ) => {
      if (workflowVersionId === options.leftVersionId) {
        return 'left_version';
      }
      if (workflowVersionId === options.rightVersionId) {
        return 'right_version';
      }
      if (workflowId) {
        const workflow = workflowById.get(workflowId);
        if (workflow?.publishedVersionId === options.leftVersionId) {
          return 'published_left';
        }
        if (workflow?.publishedVersionId === options.rightVersionId) {
          return 'published_right';
        }
      }
      return 'other';
    };
    const mapBindingRecord = <
      T extends {
        id: string;
        name: string;
        workflowId: string | null;
        workflowVersionId: string | null;
        workflowBindingMode: string;
        updatedAt: Date;
      },
    >(
      entry: T,
      extra?: Record<string, unknown>,
    ) => ({
      id: entry.id,
      name: entry.name,
      workflowId: entry.workflowId,
      workflowVersionId: entry.workflowVersionId,
      workflowBindingMode: entry.workflowBindingMode,
      appliesTo: classifyUsage(entry.workflowId, entry.workflowVersionId),
      updatedAt: entry.updatedAt,
      ...extra,
    });
    const mappedProfiles = profiles.map((profile) =>
      mapBindingRecord(profile, { matchHost: profile.matchHost }),
    );
    const mappedNewsSources = newsSources.map((source) =>
      mapBindingRecord(source, { url: source.url }),
    );

    return {
      workflows: workflows.map((workflow) => ({
        id: workflow.id,
        name: workflow.name,
        publishedVersionId: workflow.publishedVersionId,
      })),
      profiles: {
        total: mappedProfiles.length,
        followingPublishedCount: mappedProfiles.filter(
          (entry) => entry.workflowBindingMode === 'published',
        ).length,
        leftVersionCount: mappedProfiles.filter(
          (entry) => entry.workflowVersionId === options.leftVersionId,
        ).length,
        rightVersionCount: mappedProfiles.filter(
          (entry) => entry.workflowVersionId === options.rightVersionId,
        ).length,
        items: mappedProfiles,
      },
      newsSources: {
        total: mappedNewsSources.length,
        followingPublishedCount: mappedNewsSources.filter(
          (entry) => entry.workflowBindingMode === 'published',
        ).length,
        leftVersionCount: mappedNewsSources.filter(
          (entry) => entry.workflowVersionId === options.leftVersionId,
        ).length,
        rightVersionCount: mappedNewsSources.filter(
          (entry) => entry.workflowVersionId === options.rightVersionId,
        ).length,
        items: mappedNewsSources,
      },
    };
  }
}
