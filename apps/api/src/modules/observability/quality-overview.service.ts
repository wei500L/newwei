import { Injectable } from "@nestjs/common";

import {
  AdminLogsService,
  type QualityTaskLogOverview,
} from "./admin-logs.service";
import {
  NewsSourceQualityService,
  type NewsSourceQualitySummary,
} from "./news-source-quality.service";
import {
  PipelineQualityService,
  type PipelineQualitySummary,
} from "./pipeline-quality.service";

export interface QualityOverviewResponse {
  generatedAt: string;
  pipeline: PipelineQualitySummary;
  newsSources: NewsSourceQualitySummary;
  taskLogs: QualityTaskLogOverview;
}

@Injectable()
export class QualityOverviewService {
  private readonly taskLogSinceMinutes = 60;
  private readonly taskLogLimit = 10;
  private readonly newsSourceWindowHours = 24;

  constructor(
    private readonly pipelineQuality: PipelineQualityService,
    private readonly newsSourceQuality: NewsSourceQualityService,
    private readonly adminLogs: AdminLogsService,
  ) {}

  async getOverview(
    orgId: string,
    options?: { windowMinutes?: number },
  ): Promise<QualityOverviewResponse> {
    const [pipeline, newsSources, taskLogs] = await Promise.all([
      this.pipelineQuality.summary(orgId, options?.windowMinutes),
      this.newsSourceQuality.summary(orgId, this.newsSourceWindowHours),
      this.adminLogs.getQualityTaskLogsOverview(orgId, {
        sinceMinutes: this.taskLogSinceMinutes,
        limit: this.taskLogLimit,
      }),
    ]);

    return {
      generatedAt: new Date().toISOString(),
      pipeline,
      newsSources,
      taskLogs,
    };
  }
}
