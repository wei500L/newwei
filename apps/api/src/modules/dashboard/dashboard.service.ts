import { ProcessedItemModel } from "@modular/mongo";
import type { MongoConnection } from "@modular/mongo";
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { DashboardWidgetType, Prisma } from "@prisma/client";

import { toPrismaJsonValue } from "../../common/prisma-json";

import { MONGO_CONNECTION } from "../config/mongo.provider";
import { PrismaService } from "../config/prisma.service";
import { QueueService } from "../queue/queue.service";


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
      version?: number;
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
      let existingWidgets: { id: string }[] = [];

      if (input.id) {
        const existing = await tx.dashboard.findUnique({
          where: { id: input.id },
          include: { widgets: true }
        });
        if (!existing || existing.orgId !== orgId) {
          throw new NotFoundException("Dashboard not found");
        }
        if (input.version === undefined) {
          throw new BadRequestException("Dashboard version is required for update");
        }
        const updateResult = await tx.dashboard.updateMany({
          where: { id: input.id, orgId, version: input.version },
	          data: {
	            name: input.name,
	            slug: input.slug,
	            description: input.description,
	            theme: input.theme,
	            config: toPrismaJsonValue(input.config ?? {}),
	            createdById,
	            version: { increment: 1 }
	          }
	        });
        if (updateResult.count !== 1) {
          throw new ConflictException("Dashboard has been updated by another user. Please refresh and retry.");
        }
        current = await tx.dashboard.findUnique({ where: { id: input.id } });
        if (!current) {
          throw new NotFoundException("Dashboard not found");
        }
        existingWidgets = existing.widgets;
      } else {
	        current = await tx.dashboard.create({
	          data: {
	            orgId,
	            name: input.name,
	            slug: input.slug,
	            description: input.description,
	            theme: input.theme,
	            config: toPrismaJsonValue(input.config ?? {}),
	            createdById
	          }
	        });
	      }

      const widgets = input.widgets ?? [];
      const widgetsToCreate: Prisma.DashboardWidgetCreateManyInput[] = [];
      const widgetUpdatePromises: Promise<unknown>[] = [];
      const existingWidgetIds = new Set(existingWidgets.map((widget) => widget.id));
      const incomingWidgetIds = new Set<string>();

      widgets.forEach((widget, index) => {
        const sortOrder = widget.sortOrder ?? index;
        if (widget.id) {
          if (!existingWidgetIds.has(widget.id)) {
            throw new BadRequestException("Widget not found on dashboard");
          }
          incomingWidgetIds.add(widget.id);
	          widgetUpdatePromises.push(
	            tx.dashboardWidget.update({
	              where: { id: widget.id },
	              data: {
	                title: widget.title,
	                type: widget.type,
	                dataSource: widget.dataSource,
	                dataConfig: toPrismaJsonValue(widget.dataConfig ?? {}),
	                layoutX: widget.layoutX,
	                layoutY: widget.layoutY,
	                layoutW: widget.layoutW,
	                layoutH: widget.layoutH,
	                sortOrder,
	                options: toPrismaJsonValue(widget.options ?? {})
	              }
	            })
	          );
	          return;
	        }

	        widgetsToCreate.push({
	          dashboardId: current.id,
	          title: widget.title,
	          type: widget.type,
	          dataSource: widget.dataSource,
	          dataConfig: toPrismaJsonValue(widget.dataConfig ?? {}),
	          layoutX: widget.layoutX,
	          layoutY: widget.layoutY,
	          layoutW: widget.layoutW,
	          layoutH: widget.layoutH,
	          sortOrder,
	          options: toPrismaJsonValue(widget.options ?? {})
	        });
	      });

      const widgetsToDelete = existingWidgets
        .filter((existingWidget) => !incomingWidgetIds.has(existingWidget.id))
        .map((widget) => widget.id);

      if (widgetsToDelete.length) {
        await tx.dashboardWidget.deleteMany({
          where: { id: { in: widgetsToDelete }, dashboardId: current.id }
        });
      }

      if (widgetUpdatePromises.length) {
        await Promise.all(widgetUpdatePromises);
      }

      if (widgetsToCreate.length) {
        await tx.dashboardWidget.createMany({ data: widgetsToCreate });
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
