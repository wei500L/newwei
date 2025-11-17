import { Inject, Injectable } from "@nestjs/common";
import { PrismaService } from "../config/prisma.service";
import { QueueService } from "../queue/queue.service";
import { ProcessedItemModel } from "@modular/mongo";
import { MONGO_CONNECTION } from "../config/mongo.provider";
import type { MongoConnection } from "@modular/mongo";
import { DashboardWidgetType } from "@prisma/client";

@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queueService: QueueService,
    @Inject(MONGO_CONNECTION) private readonly _mongo: MongoConnection
  ) {
    void this._mongo;
  }

  async listDashboards(orgId: string) {
    return this.prisma.dashboard.findMany({
      where: { orgId },
      include: {
        widgets: {
          orderBy: { sortOrder: "asc" }
        }
      },
      orderBy: { createdAt: "asc" }
    });
  }

  async upsertDashboard(
    orgId: string,
    input: {
      id?: string;
      name: string;
      slug: string;
      description?: string;
      theme?: string;
      config?: Record<string, unknown>;
      widgets: {
        id?: string;
        title?: string;
        type: DashboardWidgetType;
        dataSource: string;
        dataConfig?: Record<string, unknown>;
        layoutX: number;
        layoutY: number;
        layoutW: number;
        layoutH: number;
        sortOrder?: number;
        options?: Record<string, unknown>;
      }[];
    },
    createdById?: string
  ) {
    const dashboard = await this.prisma.$transaction(async (tx) => {
      let current;
      if (input.id) {
        const existing = await tx.dashboard.findUnique({ where: { id: input.id } });
        if (!existing || existing.orgId !== orgId) {
          throw new Error("Dashboard not found");
        }
        current = await tx.dashboard.update({
          where: { id: input.id },
          data: {
            name: input.name,
            slug: input.slug,
            description: input.description,
            theme: input.theme,
            config: input.config ?? {},
            createdById
          }
        });
        await tx.dashboardWidget.deleteMany({ where: { dashboardId: current.id } });
      } else {
        current = await tx.dashboard.create({
          data: {
            orgId,
            name: input.name,
            slug: input.slug,
            description: input.description,
            theme: input.theme,
            config: input.config ?? {},
            createdById
          }
        });
      }

      const widgets = input.widgets ?? [];
      if (widgets.length) {
        await tx.dashboardWidget.createMany({
          data: widgets.map((widget, index) => ({
            dashboardId: current.id,
            title: widget.title,
            type: widget.type,
            dataSource: widget.dataSource,
            dataConfig: widget.dataConfig ?? {},
            layoutX: widget.layoutX,
            layoutY: widget.layoutY,
            layoutW: widget.layoutW,
            layoutH: widget.layoutH,
            sortOrder: widget.sortOrder ?? index,
            options: widget.options ?? {}
          }))
        });
      }

      return current;
    });

    return this.prisma.dashboard.findUnique({
      where: { id: dashboard.id },
      include: { widgets: { orderBy: { sortOrder: "asc" } } }
    });
  }

  async deleteDashboard(orgId: string, id: string) {
    const existing = await this.prisma.dashboard.findUnique({ where: { id } });
    if (!existing || existing.orgId !== orgId) {
      return false;
    }
    await this.prisma.dashboard.delete({ where: { id } });
    return true;
  }

  async stats(orgId: string) {
    const [itemCount, processedCount, queueStats] = await Promise.all([
      this.prisma.itemMeta.count({ where: { orgId } }),
      ProcessedItemModel.countDocuments({ orgId }),
      this.queueService.stats(orgId)
    ]);

    return {
      itemCount,
      processedCount,
      queue: queueStats.counts,
      recentQueueLogs: queueStats.recentLogs
    };
  }
}
