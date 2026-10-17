import { Injectable } from "@nestjs/common";

import { PrismaService } from "../config/prisma.service";

@Injectable()
export class SentimentService {
  constructor(private readonly prisma: PrismaService) {}

  async listEntitySnapshots(orgId: string, input: { entityName: string; entityType?: string; days: number }) {
    const days = Math.min(Math.max(Math.trunc(input.days), 1), 365);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    // Writers store the trimmed name; trimming here keeps a padded query from
    // silently returning an empty series.
    const entityName = input.entityName.trim();
    if (!entityName) {
      return [];
    }
    const entityType = typeof input.entityType === "string" ? input.entityType.trim().toLowerCase() : "";

    return this.prisma.entitySentimentSnapshot.findMany({
      where: {
        orgId,
        entityName,
        entityType,
        bucketStart: { gte: since }
      },
      orderBy: [{ bucketStart: "asc" }]
    });
  }

  async listTopicSnapshots(orgId: string, input: { topic: string; days: number }) {
    const days = Math.min(Math.max(Math.trunc(input.days), 1), 365);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    // Writers store the trimmed topic; trimming here keeps a padded query
    // from silently returning an empty series.
    const topic = input.topic.trim();
    if (!topic) {
      return [];
    }

    return this.prisma.topicSentimentSnapshot.findMany({
      where: {
        orgId,
        topic,
        bucketStart: { gte: since }
      },
      orderBy: [{ bucketStart: "asc" }]
    });
  }
}

