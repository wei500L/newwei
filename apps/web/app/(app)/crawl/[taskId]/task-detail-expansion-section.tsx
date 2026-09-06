"use client";

/**
 * Crawl Task Detail 展开/优化字段段（FE-批5A：自 task-detail.tsx 拆出）。
 * scanFullPage / virtualScroll / qualityProfile / pageTypeHint /
 * autoExpandDetails / detailExpansion / expansion 指标（含 head-signal
 * 与软失败、url-path 回退告警）/ adjustViewport。
 */

import { Alert, Descriptions, Space, Typography } from "antd";

import {
  pageTypeHintLabel,
  qualityProfileLabel,
  type CrawlTaskConfig,
  type StrategyViewModel,
} from "./task-detail-config-core-model";
import {
  buildDetailExpansionSummary,
  buildExpansionQualitySummary,
  buildHeadSignalSoftFailureDetails,
  parseTaskHeadSignalSummary,
  resolveTaskHeadSignalFallbackHint,
} from "./task-detail-expansion-model";
import type { TaskLogRecord } from "./task-detail-types";
import type { TaskDetailTranslate } from "./task-detail-types";

interface ExpansionSectionProps {
  t: TaskDetailTranslate;
  config: CrawlTaskConfig;
  strategy: StrategyViewModel;
  taskLogs: TaskLogRecord[];
}
export function TaskDetailExpansionSection({
  t,
  config,
  strategy,
  taskLogs,
}: ExpansionSectionProps) {
  const { virtualScroll } = strategy;
  const qualitySummary = qualityProfileLabel(strategy.qualityProfileValue, t);
  const pageTypeSummary = pageTypeHintLabel(strategy.pageTypeHintValue, t);
  const detailExpansionSummary = buildDetailExpansionSummary(config);
  const expansionSummary = buildExpansionQualitySummary(taskLogs);
  const expansionHeadSignalSummary = parseTaskHeadSignalSummary(taskLogs);
  const softFailureDetails = buildHeadSignalSoftFailureDetails(
    expansionHeadSignalSummary,
    t,
  );
  const fallbackHint = resolveTaskHeadSignalFallbackHint(
    expansionHeadSignalSummary,
  );
  const adjustViewportEnabled = Boolean(config?.adjustViewportToContent);

  return (
    <>
      <Descriptions.Item label={t("crawl.detail.fields.scanFullPage")}>
        {config?.scanFullPage
          ? t("crawl.detail.scanFullPageEnabled", {
              delay: config?.scrollDelayMs ?? 200,
            })
          : t("common.disabled")}
      </Descriptions.Item>
      <Descriptions.Item label={t("crawl.detail.fields.virtualScroll")}>
        {virtualScroll ? (
          <Space direction="vertical" size={0}>
            <Typography.Text style={{ fontFamily: "monospace" }}>
              containerSelector={virtualScroll.containerSelector}
            </Typography.Text>
            {virtualScroll.scrollCount != null ? (
              <Typography.Text style={{ fontFamily: "monospace" }}>
                scrollCount={virtualScroll.scrollCount}
              </Typography.Text>
            ) : null}
            {virtualScroll.scrollBy ? (
              <Typography.Text style={{ fontFamily: "monospace" }}>
                scrollBy={virtualScroll.scrollBy}
              </Typography.Text>
            ) : null}
            {virtualScroll.waitAfterScrollMs != null ? (
              <Typography.Text style={{ fontFamily: "monospace" }}>
                waitAfterScrollMs={virtualScroll.waitAfterScrollMs}
              </Typography.Text>
            ) : null}
          </Space>
        ) : (
          t("common.disabled")
        )}
      </Descriptions.Item>
      <Descriptions.Item label={t("crawl.detail.fields.qualityProfile")}>
        {qualitySummary ?? t("crawl.detail.serverDefault")}
      </Descriptions.Item>
      <Descriptions.Item label={t("crawl.detail.fields.pageTypeHint")}>
        {pageTypeSummary ?? t("crawl.detail.serverDefault")}
      </Descriptions.Item>
      <Descriptions.Item label={t("crawl.detail.fields.autoExpandDetails")}>
        {typeof strategy.autoExpandDetails === "boolean"
          ? strategy.autoExpandDetails
            ? t("common.enabled")
            : t("common.disabled")
          : t("crawl.detail.serverDefault")}
      </Descriptions.Item>
      <Descriptions.Item label={t("crawl.detail.fields.detailExpansion")}>
        {detailExpansionSummary ? (
          <Space direction="vertical" size={0}>
            {detailExpansionSummary.maxDetailUrls != null ? (
              <Typography.Text style={{ fontFamily: "monospace" }}>
                maxDetailUrls={detailExpansionSummary.maxDetailUrls}
              </Typography.Text>
            ) : null}
            {detailExpansionSummary.minRelevanceScore != null ? (
              <Typography.Text style={{ fontFamily: "monospace" }}>
                minRelevanceScore={detailExpansionSummary.minRelevanceScore}
              </Typography.Text>
            ) : null}
            {detailExpansionSummary.requireSameDomain != null ? (
              <Typography.Text style={{ fontFamily: "monospace" }}>
                requireSameDomain=
                {detailExpansionSummary.requireSameDomain ? "true" : "false"}
              </Typography.Text>
            ) : null}
            {detailExpansionSummary.allowExternalLinks != null ? (
              <Typography.Text style={{ fontFamily: "monospace" }}>
                allowExternalLinks=
                {detailExpansionSummary.allowExternalLinks ? "true" : "false"}
              </Typography.Text>
            ) : null}
            {detailExpansionSummary.minPublishTimeConfidence != null ? (
              <Typography.Text style={{ fontFamily: "monospace" }}>
                minPublishTimeConfidence=
                {detailExpansionSummary.minPublishTimeConfidence}
              </Typography.Text>
            ) : null}
            {detailExpansionSummary.preferFitMarkdownForQuality != null ? (
              <Typography.Text style={{ fontFamily: "monospace" }}>
                preferFitMarkdownForQuality=
                {detailExpansionSummary.preferFitMarkdownForQuality
                  ? "true"
                  : "false"}
              </Typography.Text>
            ) : null}
            {detailExpansionSummary.excludeUrlPatterns.length > 0 ? (
              <Typography.Text style={{ fontFamily: "monospace" }}>
                excludeUrlPatterns=
                {detailExpansionSummary.excludeUrlPatterns.join(", ")}
              </Typography.Text>
            ) : null}
            {detailExpansionSummary.includeUrlPatterns.length > 0 ? (
              <Typography.Text style={{ fontFamily: "monospace" }}>
                includeUrlPatterns=
                {detailExpansionSummary.includeUrlPatterns.join(", ")}
              </Typography.Text>
            ) : null}
          </Space>
        ) : (
          t("common.emptyValue")
        )}
      </Descriptions.Item>
      <Descriptions.Item
        label={t("crawl.detail.fields.expansionMetrics")}
      >
        {expansionSummary || expansionHeadSignalSummary ? (
          <Space direction="vertical" size={0}>
            {expansionSummary ? (
              <Typography.Text style={{ fontFamily: "monospace" }}>
                candidateCount={expansionSummary.candidateCount}
              </Typography.Text>
            ) : null}
            {expansionSummary ? (
              <Typography.Text style={{ fontFamily: "monospace" }}>
                batchCount={expansionSummary.batchCount}
              </Typography.Text>
            ) : null}
            {expansionSummary ? (
              <Typography.Text style={{ fontFamily: "monospace" }}>
                improvedSuccesses={expansionSummary.improvedSuccesses}
              </Typography.Text>
            ) : null}
            {expansionSummary?.primaryCandidatePool != null ? (
              <Typography.Text style={{ fontFamily: "monospace" }}>
                primaryCandidatePool={expansionSummary.primaryCandidatePool}
              </Typography.Text>
            ) : null}
            {expansionSummary?.fallbackCandidatePool != null ? (
              <Typography.Text style={{ fontFamily: "monospace" }}>
                fallbackCandidatePool={expansionSummary.fallbackCandidatePool}
              </Typography.Text>
            ) : null}
            {expansionSummary?.minimumCandidateCount != null ? (
              <Typography.Text style={{ fontFamily: "monospace" }}>
                minimumCandidateCount={expansionSummary.minimumCandidateCount}
              </Typography.Text>
            ) : null}
            {expansionSummary?.strictCandidateCount != null ? (
              <Typography.Text style={{ fontFamily: "monospace" }}>
                strictCandidateCount={expansionSummary.strictCandidateCount}
              </Typography.Text>
            ) : null}
            {expansionSummary?.relaxedCandidateCount != null ? (
              <Typography.Text style={{ fontFamily: "monospace" }}>
                relaxedCandidateCount={expansionSummary.relaxedCandidateCount}
              </Typography.Text>
            ) : null}
            {expansionSummary?.linkFallbackCandidateCount != null ? (
              <Typography.Text style={{ fontFamily: "monospace" }}>
                linkFallbackCandidateCount=
                {expansionSummary.linkFallbackCandidateCount}
              </Typography.Text>
            ) : null}
            {expansionHeadSignalSummary ? (
              <>
                {expansionHeadSignalSummary.attempted != null ? (
                  <Typography.Text style={{ fontFamily: "monospace" }}>
                    headSignalAttempted={expansionHeadSignalSummary.attempted}
                  </Typography.Text>
                ) : null}
                {expansionHeadSignalSummary.succeeded != null ? (
                  <Typography.Text style={{ fontFamily: "monospace" }}>
                    headSignalSucceeded={expansionHeadSignalSummary.succeeded}
                  </Typography.Text>
                ) : null}
                {expansionHeadSignalSummary.failed != null ? (
                  <Typography.Text style={{ fontFamily: "monospace" }}>
                    headSignalFailed={expansionHeadSignalSummary.failed}
                  </Typography.Text>
                ) : null}
                {expansionHeadSignalSummary.topK != null ? (
                  <Typography.Text style={{ fontFamily: "monospace" }}>
                    headSignalTopK={expansionHeadSignalSummary.topK}
                  </Typography.Text>
                ) : null}
                {expansionHeadSignalSummary.configuredTimeoutMs != null ? (
                  <Typography.Text style={{ fontFamily: "monospace" }}>
                    configuredTimeoutMs=
                    {expansionHeadSignalSummary.configuredTimeoutMs}
                  </Typography.Text>
                ) : null}
                {expansionHeadSignalSummary.configuredConcurrency != null ? (
                  <Typography.Text style={{ fontFamily: "monospace" }}>
                    configuredConcurrency=
                    {expansionHeadSignalSummary.configuredConcurrency}
                  </Typography.Text>
                ) : null}
                {expansionHeadSignalSummary.configuredMaxReadBytes != null ? (
                  <Typography.Text style={{ fontFamily: "monospace" }}>
                    configuredMaxReadBytes=
                    {expansionHeadSignalSummary.configuredMaxReadBytes}
                  </Typography.Text>
                ) : null}
                {expansionHeadSignalSummary.effectiveTimeoutMs != null ? (
                  <Typography.Text style={{ fontFamily: "monospace" }}>
                    effectiveTimeoutMs=
                    {expansionHeadSignalSummary.effectiveTimeoutMs}
                  </Typography.Text>
                ) : null}
                {expansionHeadSignalSummary.effectiveConcurrency != null ? (
                  <Typography.Text style={{ fontFamily: "monospace" }}>
                    effectiveConcurrency=
                    {expansionHeadSignalSummary.effectiveConcurrency}
                  </Typography.Text>
                ) : null}
                {expansionHeadSignalSummary.maxReadBytes != null ? (
                  <Typography.Text style={{ fontFamily: "monospace" }}>
                    maxReadBytes={expansionHeadSignalSummary.maxReadBytes}
                  </Typography.Text>
                ) : null}
                {expansionHeadSignalSummary.truncatedResponses != null ? (
                  <Typography.Text style={{ fontFamily: "monospace" }}>
                    truncatedResponses=
                    {expansionHeadSignalSummary.truncatedResponses}
                  </Typography.Text>
                ) : null}
                {expansionHeadSignalSummary.earlyStoppedResponses != null ? (
                  <Typography.Text style={{ fontFamily: "monospace" }}>
                    earlyStoppedResponses=
                    {expansionHeadSignalSummary.earlyStoppedResponses}
                  </Typography.Text>
                ) : null}
                {expansionHeadSignalSummary.skipped != null ? (
                  <Typography.Text style={{ fontFamily: "monospace" }}>
                    headSignalSkipped=
                    {expansionHeadSignalSummary.skipped ? "true" : "false"}
                  </Typography.Text>
                ) : null}
                {expansionHeadSignalSummary.softFailureCount > 0 ? (
                  <Alert
                    type="warning"
                    showIcon
                    style={{ marginTop: 8 }}
                    message={t("crawl.detail.expansion.softFailureMessage", {
                      count: expansionHeadSignalSummary.softFailureCount,
                    })}
                    description={t(
                      "crawl.detail.expansion.softFailureDescription",
                      {
                        details: softFailureDetails,
                      },
                    )}
                  />
                ) : null}
                {fallbackHint ? (
                  <Alert
                    type="warning"
                    showIcon
                    style={{ marginTop: 8 }}
                    message={t(
                      "crawl.detail.expansion.urlPathFallbackMessage",
                      {
                        count: fallbackHint.fallbackCount,
                        total: fallbackHint.totalCandidates,
                      },
                    )}
                    description={t(
                      "crawl.detail.expansion.urlPathFallbackDescription",
                      {
                        ratio: Number(
                          (fallbackHint.fallbackRatio * 100).toFixed(1),
                        ),
                      },
                    )}
                  />
                ) : null}
              </>
            ) : null}
          </Space>
        ) : (
          t("common.emptyValue")
        )}
      </Descriptions.Item>
      <Descriptions.Item label={t("crawl.detail.fields.adjustViewport")}>
        {adjustViewportEnabled ? t("common.enabled") : t("common.disabled")}
      </Descriptions.Item>
    </>
  );
}
