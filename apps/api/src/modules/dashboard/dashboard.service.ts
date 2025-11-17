import { Inject, Injectable } from "@nestjs/common";
import { PrismaService } from "../config/prisma.service";
import { QueueService } from "../queue/queue.service";
import { ProcessedItemModel } from "@modular/mongo";
import { MONGO_CONNECTION } from "../config/mongo.provider";
import type { MongoConnection } from "@modular/mongo";

@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queueService: QueueService,
    @Inject(MONGO_CONNECTION) private readonly _mongo: MongoConnection
  ) {
    void this._mongo;
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
