import {
  Args,
  Context,
  Mutation,
  Query,
  Resolver,
  UseGuards
} from "@nestjs/graphql";
import { BadRequestException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { GqlAuthGuard } from "../../common/guards/gql-auth.guard";
import { GqlPermissionsGuard } from "../../common/guards/gql-permissions.guard";
import { HasPermission } from "../decorators/has-permission.decorator";
import {
  CrawlTaskConnection,
  CrawlTaskModel,
  CrawlResultModel
} from "../models/crawl.model";
import {
  CrawlTaskDetailArgs,
  CrawlTasksQueryArgs,
  CreateCrawlTaskInput
} from "../dto/crawl.input";
import { CrawlService, CrawlTaskResult, CrawlTaskView } from "../../modules/crawl/crawl.service";
import type { AuthenticatedUser } from "../../modules/auth/auth.service";
import { PrismaService } from "../../modules/config/prisma.service";
import { CreateCrawlTaskDto } from "../../modules/crawl/dto/create-crawl-task.dto";

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
    private readonly crawlService: CrawlService,
    private readonly prisma: PrismaService
  ) {}

  @HasPermission("crawl.read")
  @Query(() => CrawlTaskConnection)
  async crawlTasks(@Context("req") req: any, @Args() args: CrawlTasksQueryArgs) {
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
        { displayName: { contains: args.search, mode: "insensitive" } },
        { targetUrl: { contains: args.search, mode: "insensitive" } }
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
      const view = this.crawlService.toView(task);
      return {
        cursor: encodeCursor(task.id),
        node: this.toGraphTask(view)
      };
    });

    return {
      edges,
      pageInfo: {
        hasNextPage,
        endCursor: edges.length > 0 ? edges[edges.length - 1].cursor : null
      },
      totalCount
    };
  }

  @HasPermission("crawl.read")
  @Query(() => CrawlTaskModel, { nullable: true })
  async crawlTask(@Context("req") req: any, @Args() args: CrawlTaskDetailArgs) {
    const requester = req?.user as AuthenticatedUser | undefined;
    if (!requester) {
      throw new BadRequestException("Unauthenticated");
    }

    const result = await this.crawlService.getTask(requester.orgId, args.id, {
      resultLimit: args.resultLimit ?? undefined,
      resultSearch: args.resultSearch ?? undefined
    });
    return this.toGraphTask(result.task);
  }

  @HasPermission("crawl.write")
  @Mutation(() => CrawlTaskModel)
  async createCrawlTask(
    @Context("req") req: any,
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

    const created = await this.crawlService.createTask(requester.orgId, requester.id, dto);
    return this.toGraphTask(created);
  }

  @HasPermission("crawl.write")
  @Mutation(() => CrawlTaskModel)
  async retryCrawlTask(@Context("req") req: any, @Args("id") id: string) {
    const requester = req?.user as AuthenticatedUser | undefined;
    if (!requester) {
      throw new BadRequestException("Unauthenticated");
    }

    const task = await this.crawlService.retryTask(requester.orgId, requester.id, id);
    return this.toGraphTask(task);
  }

  private toGraphTask(task: CrawlTaskView): CrawlTaskModel {
    return {
      ...task,
      config: task.config ? JSON.stringify(task.config) : null,
      results: task.results?.map((result) => this.toGraphResult(result))
    };
  }

  private toGraphResult(result: CrawlTaskResult): CrawlResultModel {
    return {
      ...result,
      metadata: result.metadata ? JSON.stringify(result.metadata) : null
    };
  }
}
