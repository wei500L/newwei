import { Context, Query, Resolver, Subscription, UseGuards } from "@nestjs/graphql";
import { GqlAuthGuard } from "../../common/guards/gql-auth.guard";
import { GqlPermissionsGuard } from "../../common/guards/gql-permissions.guard";
import { DashboardService } from "../../modules/dashboard/dashboard.service";
import { QueueStatsModel, QueueEventModel, QueueCountsModel } from "../models/dashboard.model";
import { HasPermission } from "../decorators/has-permission.decorator";
import { AuthenticatedUser } from "../../modules/auth/auth.service";
import { QueueEventPublisher, QueueEventPayload } from "../queue-event.publisher";
import { ForbiddenException } from "@nestjs/common";

@Resolver()
@UseGuards(GqlAuthGuard, GqlPermissionsGuard)
export class DashboardResolver {
  constructor(
    private readonly dashboardService: DashboardService,
    private readonly queueEvents: QueueEventPublisher
  ) {}

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
