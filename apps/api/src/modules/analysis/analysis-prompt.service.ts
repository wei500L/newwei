import { analysisPromptTemplates, renderPromptTemplate } from "@modular/config";
import { Injectable } from "@nestjs/common";

import { EnvService } from "../config/config.service";
import type { LiteLlmMessage } from "../news-pipeline/litellm.service";

import type { AnomalyInput, CorrelationInput } from "./analysis.types";
import type { AnomalyDetectionResult, SeriesPoint } from "./anomaly-detector";
import {
  detectRollingSpike,
  detectTrend,
  detectVolumeSpike,
  detectZScoreAnomalies
} from "./anomaly-detector";

@Injectable()
export class AnalysisPromptService {
  constructor(private readonly env: EnvService) {}

  buildCorrelationMessages(input: CorrelationInput): LiteLlmMessage[] {
    const system = this.env.analysisConfig.promptCorrelationSystem ?? analysisPromptTemplates.correlation.system;
    const userTemplate = this.env.analysisConfig.promptCorrelationUser ?? analysisPromptTemplates.correlation.user;
    const news = input.newsSummaries?.length
      ? input.newsSummaries.map((n, idx) => `${idx + 1}. ${n}`).join("\n")
      : "无相关新闻";
    const user = renderPromptTemplate(userTemplate, {
      indicatorName: input.indicatorName,
      value: input.value,
      changePercent: input.changePercent,
      news,
      startDate: input.startDate,
      endDate: input.endDate
    });
    return [
      { role: "system", content: system },
      { role: "user", content: user }
    ];
  }

  buildAnomalyMessages(input: AnomalyInput): {
    messages: LiteLlmMessage[];
    statisticalFindings: AnomalyDetectionResult[];
    statsSummary: string;
  } {
    const statisticalFindings = this.evaluateSeriesForAnomalies(input.series ?? []);
    const statsSummary = statisticalFindings.length
      ? statisticalFindings
          .map((finding, idx) => {
            const timestamp =
              finding.point.timestamp instanceof Date ? finding.point.timestamp.toISOString() : finding.point.timestamp;
            return `${idx + 1}. ${finding.reason} | 值 ${finding.point.value} @ ${timestamp} (score ${finding.score.toFixed(
              2
            )})`;
          })
          .join("\n")
      : "未检测到显著的统计异常";

    const system = this.env.analysisConfig.promptAnomalySystem ?? analysisPromptTemplates.anomaly.system;
    const userTemplate = this.env.analysisConfig.promptAnomalyUser ?? analysisPromptTemplates.anomaly.user;
    const news = input.newsList?.length ? input.newsList.map((n, idx) => `${idx + 1}. ${n}`).join("\n") : "无相关新闻";
    const policies = input.policyList?.length
      ? input.policyList.map((p, idx) => `${idx + 1}. ${p}`).join("\n")
      : "无相关政策";
    const user = renderPromptTemplate(userTemplate, {
      metric: input.metric,
      timestamp: input.timestamp,
      value: input.value,
      deviationPercent: input.deviationPercent,
      news,
      policies,
      statsSummary
    });

    return {
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ],
      statisticalFindings,
      statsSummary
    };
  }

  private evaluateSeriesForAnomalies(series: SeriesPoint[]) {
    const z = detectZScoreAnomalies(series);
    const spikes = detectRollingSpike(series);
    const trends = detectTrend(series);
    const volumes = detectVolumeSpike(series);
    return [...z, ...spikes, ...trends, ...volumes];
  }
}
