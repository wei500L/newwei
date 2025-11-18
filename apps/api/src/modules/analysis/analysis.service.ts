import { Inject, Injectable } from "@nestjs/common";
import { Queue } from "bullmq";
import { AnalysisResultModel } from "@modular/mongo";
import { LiteLlmService } from "../news-pipeline/litellm.service";
import { EnvService } from "../config/config.service";
import { ANALYSIS_QUEUE } from "./analysis.constants";
import { AnalysisJobPayload, AnomalyInput, CorrelationInput } from "./analysis.types";
import { createLogger } from "@modular/utils";
import { ANALYSIS_PUBSUB } from "./analysis.pubsub";
import { PubSubEngine } from "graphql-subscriptions";
import { detectZScoreAnomalies, detectRollingSpike, detectTrend, detectVolumeSpike, SeriesPoint } from "./anomaly-detector";

const logger = createLogger({ name: "analysis-service" });

@Injectable()
export class AnalysisService {
  constructor(
    private readonly llm: LiteLlmService,
    private readonly env: EnvService,
    @Inject(ANALYSIS_QUEUE) private readonly queue: Queue<AnalysisJobPayload>,
    @Inject(ANALYSIS_PUBSUB) private readonly pubsub: PubSubEngine
  ) {}

  async submitCorrelation(orgId: string, input: CorrelationInput, triggeredById?: string) {
    const record = await AnalysisResultModel.create({
      orgId,
      type: "correlation",
      status: "pending",
      input,
      triggeredById
    });
    await this.queue.add(
      "correlation",
      { type: "correlation", analysisId: record.id },
      { jobId: `corr:${record.id}`, removeOnComplete: true, attempts: this.env.analysisConfig.maxRetries }
    );
    return record;
  }

  async submitAnomaly(orgId: string, input: AnomalyInput, triggeredById?: string) {
    const record = await AnalysisResultModel.create({
      orgId,
      type: "anomaly",
      status: "pending",
      input,
      triggeredById
    });
    await this.queue.add(
      "anomaly",
      { type: "anomaly", analysisId: record.id },
      { jobId: `anomaly:${record.id}`, removeOnComplete: true, attempts: this.env.analysisConfig.maxRetries }
    );
    return record;
  }

  async listResults(orgId: string, limit = 50) {
    return AnalysisResultModel.find({ orgId }).sort({ createdAt: -1 }).limit(limit).lean();
  }

  async process(job: AnalysisJobPayload) {
    const record = await AnalysisResultModel.findById(job.analysisId);
    if (!record) {
      logger.warn({ job }, "Analysis record not found");
      return;
    }
    record.status = "running";
    await record.save();

    try {
      if (job.type === "correlation") {
        const output = await this.runCorrelation(record.input as CorrelationInput);
        record.output = output;
        record.summary = output.summary;
      } else {
        const output = await this.runAnomaly(record.input as AnomalyInput);
        record.output = output;
        record.summary = output.summary;
      }
      record.status = "completed";
      await record.save();
      await this.publish(record.orgId, record.id, record.type, record.status, record.summary ?? undefined, record.createdAt);
    } catch (error) {
      logger.error({ job, error }, "Analysis job failed");
      record.status = "failed";
      record.error = error instanceof Error ? error.message : String(error);
      await record.save();
      await this.publish(record.orgId, record.id, record.type, record.status, record.summary ?? undefined, record.createdAt);
      throw error;
    }
  }

  private async runCorrelation(input: CorrelationInput) {
    const systemPrompt = "你是一位专业的金融数据分析师。请围绕数据关联与情绪总结，提供简洁可执行的输出。";
    const news = input.newsSummaries?.length ? input.newsSummaries.map((n, idx) => `${idx + 1}. ${n}`).join("\n") : "无相关新闻";
    const userPrompt = [
      "任务：分析以下数据之间的关联性",
      `经济指标：${input.indicatorName}，当前值 ${input.value}，环比变化 ${input.changePercent}%`,
      `相关新闻：${news}`,
      `时间范围：${input.startDate} 至 ${input.endDate}`,
      "",
      "输出要求：",
      "1. 数据关联性分析（200字以内）",
      "2. 关键驱动因素（3-5条）",
      "3. 情绪判断：积极/中性/消极",
      "4. 潜在影响预测（100字以内）"
    ].join("\n");
    const completion = await this.llm.acompletion({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ]
    });
    const content = completion.choices?.[0]?.message?.content ?? "";
    return { summary: content, raw: completion };
  }

  private async runAnomaly(input: AnomalyInput) {
    const systemPrompt = "角色：金融数据异常分析专家。请解释异常的可能原因并结合新闻与政策。";
    const news = input.newsList?.length ? input.newsList.map((n, idx) => `${idx + 1}. ${n}`).join("\n") : "无相关新闻";
    const policies = input.policyList?.length ? input.policyList.map((p, idx) => `${idx + 1}. ${p}`).join("\n") : "无相关政策";
    const userPrompt = [
      "任务：解释以下数据异常的可能原因",
      `指标：${input.metric}`,
      `异常时间：${input.timestamp}`,
      `异常值：${input.value}（偏离均值 ${input.deviationPercent}%）`,
      `同期新闻：${news}`,
      `相关政策：${policies}`,
      "",
      "输出要求：",
      "1. 异常原因分析（3-5条，按可能性排序）",
      "2. 每条原因需引用具体新闻或政策依据",
      "3. 总结（50字以内）"
    ].join("\n");
    const completion = await this.llm.acompletion({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ]
    });
    const content = completion.choices?.[0]?.message?.content ?? "";
    return { summary: content, raw: completion };
  }

  evaluateSeriesForAnomalies(series: SeriesPoint[]) {
    const z = detectZScoreAnomalies(series);
    const spikes = detectRollingSpike(series);
    const trends = detectTrend(series);
    const volumes = detectVolumeSpike(series);
    return [...z, ...spikes, ...trends, ...volumes];
  }

  private async publish(orgId: string, id: string, type: string, status: string, summary?: string, createdAt?: Date) {
    await this.pubsub.publish("analysisEvents", {
      orgId,
      result: {
        id,
        type,
        status,
        summary,
        createdAt: (createdAt ?? new Date()).toISOString()
      }
    });
  }
}
