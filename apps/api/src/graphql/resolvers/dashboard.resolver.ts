import { ForbiddenException, UseGuards } from "@nestjs/common";
import { Args, Context, Mutation, Query, Resolver, Subscription } from "@nestjs/graphql";

import { GqlAuthGuard } from "../../common/guards/gql-auth.guard";
import { GqlPermissionsGuard } from "../../common/guards/gql-permissions.guard";
import { AuthenticatedUser } from "../../modules/auth/auth.service";
import { DashboardService } from "../../modules/dashboard/dashboard.service";
import { QueueEventPublisher, QueueEventPayload } from "../../modules/queue/queue-event.publisher";
import { HasPermission } from "../decorators/has-permission.decorator";
import { UpsertDashboardInput } from "../dto/dashboard.input";
import { QueueStatsModel, QueueEventModel, QueueCountsModel, DashboardModel } from "../models/dashboard.model";

@Resolver()
@UseGuards(GqlAuthGuard, GqlPermissionsGuard)
export class DashboardResolver {
  constructor(
    private readonly dashboardService: DashboardService,
    private readonly queueEvents: QueueEventPublisher
  ) {}

  @HasPermission("dashboards.read")
  @Query(() => [DashboardModel])
  async dashboards(@Context("req") req: any): Promise<DashboardModel[]> {
    const requester = req?.user as AuthenticatedUser | undefined;
    if (!requester) {
      throw new ForbiddenException("Unauthenticated");
    }
    const dashboards = await this.dashboardService.listDashboards(requester.orgId);
    return dashboards.map((dashboard) => ({
      id: dashboard.id,
      version: dashboard.version,
      name: dashboard.name,
      slug: dashboard.slug,
      description: dashboard.description ?? undefined,
      theme: dashboard.theme ?? undefined,
      config: dashboard.config as any,
      createdAt: dashboard.createdAt,
      updatedAt: dashboard.updatedAt,
      widgets:
        dashboard.widgets?.map((widget) => ({
          id: widget.id,
          title: widget.title ?? undefined,
          type: widget.type,
          dataSource: widget.dataSource,
          dataConfig: widget.dataConfig as any,
          layoutX: widget.layoutX,
          layoutY: widget.layoutY,
          layoutW: widget.layoutW,
          layoutH: widget.layoutH,
          sortOrder: widget.sortOrder,
          options: widget.options as any
        })) ?? []
    }));
  }

  @HasPermission("dashboards.write")
  @Mutation(() => DashboardModel)
  async upsertDashboard(
    @Context("req") req: any,
    @Args("input") input: UpsertDashboardInput
  ): Promise<DashboardModel> {
    const requester = req?.user as AuthenticatedUser | undefined;
    if (!requester) {
      throw new ForbiddenException("Unauthenticated");
    }
    const dashboard = await this.dashboardService.upsertDashboard(requester.orgId, input, requester.id);
    if (!dashboard) {
      throw new ForbiddenException("Unable to persist dashboard");
    }
    return {
      id: dashboard.id,
      version: dashboard.version,
      name: dashboard.name,
      slug: dashboard.slug,
      description: dashboard.description ?? undefined,
      theme: dashboard.theme ?? undefined,
      config: dashboard.config as any,
      createdAt: dashboard.createdAt,
      updatedAt: dashboard.updatedAt,
      widgets:
        dashboard.widgets?.map((widget) => ({
          id: widget.id,
          title: widget.title ?? undefined,
          type: widget.type,
          dataSource: widget.dataSource,
          dataConfig: widget.dataConfig as any,
          layoutX: widget.layoutX,
          layoutY: widget.layoutY,
          layoutW: widget.layoutW,
          layoutH: widget.layoutH,
          sortOrder: widget.sortOrder,
          options: widget.options as any
        })) ?? []
    };
  }

  @HasPermission("dashboards.write")
  @Mutation(() => Boolean)
  async deleteDashboard(@Context("req") req: any, @Args("id") id: string): Promise<boolean> {
    const requester = req?.user as AuthenticatedUser | undefined;
    if (!requester) {
      throw new ForbiddenException("Unauthenticated");
    }
    return this.dashboardService.deleteDashboard(requester.orgId, id);
  }

  @HasPermission("queue.manage")
  @Query(() => QueueStatsModel)
  async queueStats(@Context("req") req: any): Promise<QueueStatsModel> {
    const requester = req?.user as AuthenticatedUser | undefined;
    if (!requester) {
      throw new ForbiddenException("Unauthenticated");
    }
    const stats = await this.dashboardService.stats(requester.orgId);
    return {
      counts: {
        waiting: stats.queue.waiting ?? 0,
        active: stats.queue.active ?? 0,
        completed: stats.queue.completed ?? 0,
        failed: stats.queue.failed ?? 0,
        delayed: stats.queue.delayed ?? 0
      } satisfies QueueCountsModel,
      processedCount: stats.processedCount,
      itemCount: stats.itemCount,
      recentLogs:
        stats.recentQueueLogs?.map((log) => ({
          event: `${log.stage ?? "stage"}:${log.status ?? "status"}`.toUpperCase(),
          jobId: log.jobId ?? "n/a",
          data: JSON.stringify({
            stage: log.stage,
            status: log.status,
            message: log.message
          }),
          timestamp: log.createdAt ? new Date(log.createdAt).toISOString() : new Date().toISOString()
        })) ?? []
    };
  }

  @HasPermission("queue.manage")
  @Subscription(() => QueueEventModel, {
    name: "queueEvents",
    resolve: (value: { queueEvents: QueueEventPayload }) => ({
      event: value.queueEvents.event,
      jobId: value.queueEvents.jobId,
      data: value.queueEvents.data ? JSON.stringify(value.queueEvents.data) : undefined,
      timestamp: value.queueEvents.timestamp
    })
  })
  queueEventsSubscription(@Context("req") req: any): AsyncIterableIterator<{ queueEvents: QueueEventPayload }> {
    const requester = req?.user as AuthenticatedUser | undefined;
    if (!requester) {
      throw new ForbiddenException("Unauthenticated");
    }
    return this.queueEvents.asyncIterator(requester.orgId);
  }
}
