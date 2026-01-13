import { BadRequestException, UseGuards } from "@nestjs/common";
import {
  Args,
  Context,
  Mutation,
  Query,
  Resolver,
} from "@nestjs/graphql";
import { Prisma } from "@prisma/client";

import { GqlAuthGuard } from "../../common/guards/gql-auth.guard";
import { GqlPermissionsGuard } from "../../common/guards/gql-permissions.guard";
import { resolveRequestIp } from "../../common/request-ip";
import type { AuthenticatedUser } from "../../modules/auth/auth.service";
import { PrismaService } from "../../modules/config/prisma.service";
import { CrawlMetadataService } from "../../modules/crawl/crawl-metadata.service";
import { CrawlTaskService } from "../../modules/crawl/crawl-task.service";
import type {
  CrawlLinkAnalysis,
  CrawlLinkAnalysisLink,
  CrawlMetadataResult,
  CrawlTaskResult,
  CrawlTaskView,
  CrawlMemoryStats
} from "../../modules/crawl/crawl.types";
import { CreateCrawlTaskDto } from "../../modules/crawl/dto/create-crawl-task.dto";
import { HasPermission } from "../decorators/has-permission.decorator";
import {
  CrawlTaskDetailArgs,
  CrawlTasksQueryArgs,
  CreateCrawlTaskInput,
  CrawlMetadataInput
} from "../dto/crawl.input";
import type { GqlRequest } from "../graphql.types";
import {
  CrawlTaskConnection,
  CrawlTaskModel,
  CrawlResultModel,
  CrawlMemoryStatsModel,
  CrawlLinkAnalysisModel,
  CrawlLinkModel,
  CrawlLinkStatsModel,
  CrawlMetadataResultModel
} from "../models/crawl.model";

function encodeCursor(value: string) {
  return Buffer.from(value, "utf8").toString("base64");
}

function decodeCursor(cursor?: string | null) {
  return cursor ? Buffer.from(cursor, "base64").toString("utf8") : undefined;
}

@Resolver(() => CrawlTaskModel)
@UseGuards(GqlAuthGuard, GqlPermissionsGuard)
export class CrawlResolver {
  constructor(
    private readonly crawlTaskService: CrawlTaskService,
    private readonly metadataService: CrawlMetadataService,
    private readonly prisma: PrismaService
  ) {}

  @HasPermission("crawl.read")
  @Query(() => CrawlTaskConnection)
  async crawlTasks(@Context("req") req: GqlRequest, @Args() args: CrawlTasksQueryArgs) {
    const requester = req?.user as AuthenticatedUser | undefined;
    if (!requester) {
      throw new BadRequestException("Unauthenticated");
    }

    const take = Math.min(args.first, 50);
    const cursorId = decodeCursor(args.after);
    const where: Prisma.CrawlTaskWhereInput = {
      orgId: requester.orgId
    };
    if (args.status) {
      where.status = args.status;
    }
	    if (args.search) {
	      where.OR = [
	        { displayName: { contains: args.search } },
	        { targetUrl: { contains: args.search } }
	      ];
	    }

    const tasks = await this.prisma.crawlTask.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: take + 1,
      ...(cursorId
        ? {
            skip: 1,
            cursor: { id: cursorId }
          }
        : {}),
      include: { _count: { select: { results: true } } }
    });

    const hasNextPage = tasks.length > take;
    const nodes = tasks.slice(0, take);
    const totalCount = await this.prisma.crawlTask.count({ where });

    const edges = nodes.map((task) => {
      const view = this.crawlTaskService.toView(task);
      return {
        cursor: encodeCursor(task.id),
        node: this.toGraphTask(view)
      };
    });

	    return {
	      edges,
	      pageInfo: {
	        hasNextPage,
	        endCursor: edges.at(-1)?.cursor ?? null
	      },
	      totalCount
	    };
	  }

  @HasPermission("crawl.read")
  @Query(() => CrawlTaskModel, { nullable: true })
  async crawlTask(@Context("req") req: GqlRequest, @Args() args: CrawlTaskDetailArgs) {
    const requester = req?.user as AuthenticatedUser | undefined;
    if (!requester) {
      throw new BadRequestException("Unauthenticated");
    }

    const result = await this.crawlTaskService.getTask(requester.orgId, args.id, {
      resultLimit: args.resultLimit ?? undefined,
      resultSearch: args.resultSearch ?? undefined
    });
    return this.toGraphTask(result.task);
  }

  @HasPermission("crawl.write")
  @Mutation(() => CrawlTaskModel)
  async createCrawlTask(
    @Context("req") req: GqlRequest,
    @Args("input") input: CreateCrawlTaskInput
  ) {
    const requester = req?.user as AuthenticatedUser | undefined;
    if (!requester) {
      throw new BadRequestException("Unauthenticated");
    }

    const dto: CreateCrawlTaskDto = {
      url: input.url,
      displayName: input.displayName,
      timeRangeFrom: input.timeRange?.from,
      timeRangeTo: input.timeRange?.to,
      concurrency: input.concurrency ?? undefined,
      keywords: input.keywords ?? undefined,
      options: input.options ?? undefined
    };

    const created = await this.crawlTaskService.createTask(
      requester.orgId,
      requester.id,
      dto,
      resolveRequestIp(req)
    );
    return this.toGraphTask(created);
  }

  @HasPermission("crawl.write")
  @Mutation(() => CrawlTaskModel)
  async retryCrawlTask(@Context("req") req: GqlRequest, @Args("id") id: string) {
    const requester = req?.user as AuthenticatedUser | undefined;
    if (!requester) {
      throw new BadRequestException("Unauthenticated");
    }

    const task = await this.crawlTaskService.retryTask(
      requester.orgId,
      requester.id,
      id,
      resolveRequestIp(req)
    );
    return this.toGraphTask(task);
  }

  @HasPermission("crawl.write")
  @Mutation(() => Boolean)
  async deleteCrawlTask(@Context("req") req: GqlRequest, @Args("id") id: string): Promise<boolean> {
    const requester = req?.user as AuthenticatedUser | undefined;
    if (!requester) {
      throw new BadRequestException("Unauthenticated");
    }
    await this.crawlTaskService.deleteTask(requester.orgId, requester.id, id);
    return true;
  }

  @HasPermission("crawl.read")
  @Query(() => [CrawlMetadataResultModel])
  async crawlMetadata(@Context("req") req: GqlRequest, @Args("input") input: CrawlMetadataInput) {
    const requester = req?.user as AuthenticatedUser | undefined;
    if (!requester) {
      throw new BadRequestException("Unauthenticated");
    }
    const payload = input ?? {};
    const results = await this.metadataService.extract(payload);
    return results.map((result) => this.toGraphMetadata(result));
  }

  private toGraphTask(task: CrawlTaskView): CrawlTaskModel {
    return {
      ...task,
      config: task.config ? JSON.stringify(task.config) : null,
      results: task.results?.map((result) => this.toGraphResult(result)),
      memoryStats: task.memoryStats ? this.toMemoryStats(task.memoryStats) : null
    };
  }

  private toGraphResult(result: CrawlTaskResult): CrawlResultModel {
    return {
      ...result,
      metadata: result.metadata ? JSON.stringify(result.metadata) : null,
      media: result.media ? JSON.stringify(result.media) : null,
      mediaAssets: result.mediaAssets ? JSON.stringify(result.mediaAssets) : null,
      linkAnalysis: result.linkAnalysis ? this.toGraphLinkAnalysis(result.linkAnalysis) : null,
      tables: result.tables ?? null
    };
  }

  private toMemoryStats(stats: CrawlMemoryStats): CrawlMemoryStatsModel {
    return {
      serverMemoryMb: stats.serverMemoryMb ?? null,
      peakMemoryMb: stats.peakMemoryMb ?? null,
      efficiencyPercent: stats.efficiencyPercent ?? null
    };
  }

  private toGraphLinkAnalysis(analysis: CrawlLinkAnalysis): CrawlLinkAnalysisModel {
    return {
      stats: this.toGraphLinkStats(analysis.stats),
      buckets: analysis.buckets.map((bucket) => ({
        kind: bucket.kind,
        links: bucket.links.map((link) => this.toGraphLink(link))
      })),
      topLinks: analysis.topLinks.map((link) => this.toGraphLink(link)),
      lowQualityLinks: analysis.lowQualityLinks.map((link) => this.toGraphLink(link))
    };
  }

  private toGraphLinkStats(stats: CrawlLinkAnalysis["stats"]): CrawlLinkStatsModel {
    return {
      totalLinks: stats.totalLinks,
      internalLinks: stats.internalLinks,
      externalLinks: stats.externalLinks,
      averageIntrinsicScore: stats.averageIntrinsicScore ?? null,
      highQualityLinks: stats.highQualityLinks ?? null,
      lowQualityLinks: stats.lowQualityLinks ?? null
    };
  }

  private toGraphLink(link: CrawlLinkAnalysisLink): CrawlLinkModel {
    return {
      href: link.href,
      text: link.text ?? null,
      title: link.title ?? null,
      baseDomain: link.baseDomain ?? null,
      rel: link.rel ?? null,
      type: link.type ?? null,
      intrinsicScore: link.intrinsicScore ?? null,
      contextualScore: link.contextualScore ?? null,
      totalScore: link.totalScore ?? null
    };
  }

  private toGraphMetadata(result: CrawlMetadataResult): CrawlMetadataResultModel {
    return {
      url: result.url,
      status: result.status,
      httpStatus: result.httpStatus ?? null,
      fetchedAt: result.fetchedAt ?? null,
      title: result.title ?? null,
      description: result.description ?? null,
      keywords: result.keywords ?? null,
      author: result.author ?? null,
      metaTags: result.metaTags,
      openGraph: result.openGraph,
      jsonLd: result.jsonLd,
      relevanceScore: result.relevanceScore ?? null,
      error: result.error ?? null
    };
  }
}
