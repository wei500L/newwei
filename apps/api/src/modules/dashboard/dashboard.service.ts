import { ProcessedItemModel } from "@modular/mongo";
import type { MongoConnection } from "@modular/mongo";
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { DashboardWidgetType, Prisma } from "@prisma/client";

import { toPrismaJsonValue } from "../../common/prisma-json";
import { MONGO_CONNECTION } from "../config/mongo.provider";
import { PrismaService } from "../config/prisma.service";
import { QueueService } from "../queue/queue.service";

/** One stored DashboardWidget row used by the save diff. */
interface DashboardWidgetRecord {
  id: string;
  title: string | null;
  type: DashboardWidgetType;
  dataSource: string;
  dataConfig: Prisma.JsonValue;
  layoutX: number;
  layoutY: number;
  layoutW: number;
  layoutH: number;
  sortOrder: number;
  options: Prisma.JsonValue;
}

/** The normalized field set one existing widget update writes. */
interface DashboardWidgetUpdateFields {
  title?: string | null;
  type: DashboardWidgetType;
  dataSource: string;
  dataConfig: Prisma.InputJsonValue;
  layoutX: number;
  layoutY: number;
  layoutW: number;
  layoutH: number;
  sortOrder: number;
  options: Prisma.InputJsonValue;
}

const isJsonRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

/**
 * Compares two JSON values the way MySQL stores JSON: object key order is
 * ignored, array order is significant, and everything else compares by value.
 */
const jsonValuesEqual = (left: unknown, right: unknown): boolean => {
  if (left === right) {
    return true;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    return left.every((item, index) => jsonValuesEqual(item, right[index]));
  }
  if (isJsonRecord(left) && isJsonRecord(right)) {
    const leftKeys = Object.keys(left);
    if (leftKeys.length !== Object.keys(right).length) {
      return false;
    }
    return leftKeys.every(
      (key) => Object.prototype.hasOwnProperty.call(right, key) && jsonValuesEqual(left[key], right[key])
    );
  }
  return false;
};

/**
 * Reports whether the normalized widget update would change the stored row. An
 * omitted title is not part of the update, so it can never mark the row
 * changed; the JSON columns always carry the `?? {}` value that would be
 * written.
 */
const dashboardWidgetChanged = (
  existing: DashboardWidgetRecord,
  update: DashboardWidgetUpdateFields
): boolean => {
  if (update.title !== undefined && update.title !== existing.title) {
    return true;
  }
  if (update.type !== existing.type || update.dataSource !== existing.dataSource) {
    return true;
  }
  if (
    update.layoutX !== existing.layoutX ||
    update.layoutY !== existing.layoutY ||
    update.layoutW !== existing.layoutW ||
    update.layoutH !== existing.layoutH ||
    update.sortOrder !== existing.sortOrder
  ) {
    return true;
  }
  return (
    !jsonValuesEqual(update.dataConfig, existing.dataConfig) ||
    !jsonValuesEqual(update.options, existing.options)
  );
};

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
      let existingWidgets: DashboardWidgetRecord[] = [];

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
      const widgetUpdates: { id: string; data: Prisma.DashboardWidgetUpdateInput }[] = [];
      const existingWidgetById = new Map<string, DashboardWidgetRecord>(
        existingWidgets.map((widget) => [widget.id, widget] as const)
      );
      const incomingWidgetIds = new Set<string>();

      widgets.forEach((widget, index) => {
        const sortOrder = widget.sortOrder ?? index;
        if (widget.id) {
          const existingWidget = existingWidgetById.get(widget.id);
          if (!existingWidget) {
            throw new BadRequestException("Widget not found on dashboard");
          }
          incomingWidgetIds.add(widget.id);
          const data: DashboardWidgetUpdateFields = {
            type: widget.type,
            dataSource: widget.dataSource,
            dataConfig: toPrismaJsonValue(widget.dataConfig ?? {}),
            layoutX: widget.layoutX,
            layoutY: widget.layoutY,
            layoutW: widget.layoutW,
            layoutH: widget.layoutH,
            sortOrder,
            options: toPrismaJsonValue(widget.options ?? {})
          };
          // title keeps the Prisma three-state semantics: omitted leaves the
          // column, null clears it, a string sets it. An omitted title can
          // therefore never make the row "changed".
          if (widget.title !== undefined) {
            data.title = widget.title;
          }
          if (dashboardWidgetChanged(existingWidget, data)) {
            widgetUpdates.push({ id: widget.id, data });
          }
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

      if (widgetUpdates.length) {
        // Only the widgets whose normalized target fields differ from the
        // stored row are written, so an unchanged widget keeps its updatedAt.
        await Promise.all(
          widgetUpdates.map((update) =>
            tx.dashboardWidget.update({ where: { id: update.id }, data: update.data })
          )
        );
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
      queueCountsAvailable: queueStats.countsAvailable,
      recentQueueLogs: queueStats.recentLogs
    };
  }
}
