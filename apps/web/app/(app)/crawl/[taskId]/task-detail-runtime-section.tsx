"use client";

/**
 * Crawl Task Detail 运行时参数字段段（FE-批5A：自 task-detail.tsx 拆出）。
 * js-only/JS 步骤/等待条件与超时/延迟与信号量/robots/表单移除/
 * 代理路由/附加 URL。
 */

import { Descriptions, Space, Typography } from "antd";
import { useTranslation } from "react-i18next";

import {
  buildProxySummary,
  type CrawlTaskConfig,
} from "./task-detail-config-core-model";
import { shortenScript } from "./task-detail-formatters";
import { buildAdditionalUrls } from "./task-detail-multi-url-model";
import {
  buildDynamicJsSteps,
  buildRuntimeParams,
  buildWaitCondition,
  buildWaitUntilSummary,
  resolveWaitUntilValue,
} from "./task-detail-runtime-model";

export function TaskDetailRuntimeSection({
  config,
}: {
  config: CrawlTaskConfig;
}) {
  const { t } = useTranslation();
  const dynamicJsSteps = buildDynamicJsSteps(config);
  const waitCondition = buildWaitCondition(config);
  const waitUntilSummary = buildWaitUntilSummary(
    resolveWaitUntilValue(config),
    t,
  );
  const runtime = buildRuntimeParams(config);
  const proxySummary = buildProxySummary(config, t);
  const additionalUrls = buildAdditionalUrls(config);
  const jsOnlyMode = Boolean(config?.jsOnly);

  return (
    <>
      <Descriptions.Item label={t("crawl.detail.fields.jsOnly")}>
        {jsOnlyMode ? t("common.enabled") : t("common.disabled")}
      </Descriptions.Item>
      <Descriptions.Item label={t("crawl.detail.fields.jsSteps")}>
        {dynamicJsSteps.length ? (
          <Space direction="vertical" size={0}>
            {dynamicJsSteps.map((snippet, index) => (
              <Typography.Text
                key={`js-${index}`}
                style={{ fontFamily: "monospace" }}
              >
                {shortenScript(snippet)}
              </Typography.Text>
            ))}
          </Space>
        ) : (
          t("common.emptyValue")
        )}
      </Descriptions.Item>
      <Descriptions.Item label={t("crawl.detail.fields.waitCondition")}>
        {waitCondition
          ? shortenScript(waitCondition)
          : t("common.emptyValue")}
      </Descriptions.Item>
      <Descriptions.Item label={t("crawl.detail.fields.waitTimeout")}>
        {runtime.waitTimeoutMs
          ? t("crawl.detail.waitTimeoutValue", {
              value: runtime.waitTimeoutMs,
            })
          : t("crawl.detail.default")}
      </Descriptions.Item>
      <Descriptions.Item
        label={t("crawl.detail.fields.waitUntil")}
      >
        {waitUntilSummary ?? t("crawl.detail.default")}
      </Descriptions.Item>
      <Descriptions.Item
        label={t("crawl.detail.fields.pageTimeout")}
      >
        {runtime.pageTimeoutMs != null
          ? `${Math.round(runtime.pageTimeoutMs)} ms`
          : t("crawl.detail.default")}
      </Descriptions.Item>
      <Descriptions.Item
        label={t("crawl.detail.fields.delayBeforeReturnHtml")}
      >
        {runtime.delayBeforeReturnHtmlMs != null
          ? `${Math.round(runtime.delayBeforeReturnHtmlMs)} ms`
          : t("crawl.detail.default")}
      </Descriptions.Item>
      <Descriptions.Item
        label={t("crawl.detail.fields.meanDelay")}
      >
        {runtime.meanDelayMs != null
          ? `${Math.round(runtime.meanDelayMs)} ms`
          : t("crawl.detail.default")}
      </Descriptions.Item>
      <Descriptions.Item
        label={t("crawl.detail.fields.maxDelayRange")}
      >
        {runtime.maxDelayRangeMs != null
          ? `${Math.round(runtime.maxDelayRangeMs)} ms`
          : t("crawl.detail.default")}
      </Descriptions.Item>
      <Descriptions.Item
        label={t("crawl.detail.fields.semaphoreCount")}
      >
        {runtime.semaphoreCount != null
          ? runtime.semaphoreCount
          : t("crawl.detail.default")}
      </Descriptions.Item>
      <Descriptions.Item
        label={t("crawl.detail.fields.robotsPolicy")}
      >
        {t("crawl.detail.robotsPolicy.ignore")}
      </Descriptions.Item>
      <Descriptions.Item
        label={t("crawl.detail.fields.removeForms")}
      >
        {runtime.removeFormsEnabled == null
          ? t("crawl.detail.default")
          : runtime.removeFormsEnabled
            ? t("common.enabled")
            : t("common.disabled")}
      </Descriptions.Item>
      <Descriptions.Item label={t("crawl.detail.fields.proxyRoute")}>
        {proxySummary}
      </Descriptions.Item>
      <Descriptions.Item label={t("crawl.detail.fields.additionalUrls")}>
        {additionalUrls.length ? (
          <Space wrap>
            {additionalUrls.map((url) => (
              <Typography.Link
                key={url}
                href={url}
                target="_blank"
                rel="noreferrer"
              >
                {url}
              </Typography.Link>
            ))}
          </Space>
        ) : (
          t("common.emptyValue")
        )}
      </Descriptions.Item>
    </>
  );
}
