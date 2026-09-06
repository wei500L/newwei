"use client";

/**
 * Create Crawl Task 抽屉的抓取优化卡（FE-批5B：自 CreateCrawlTaskDrawer.tsx 拆出）。
 * 无 LLM 提示、qualityProfile/pageTypeHint、autoExpandDetails 与
 * detailExpansion 条件字段组（开启时写入默认值，关闭时整体清除）。
 */

import { Alert, Card, Form, InputNumber, Select, Switch, Typography } from "antd";
import { useTranslation } from "react-i18next";

import type { CreateCrawlTaskFormValues } from "../../types";

export function OptimizationFields() {
  const { t } = useTranslation();
  const form = Form.useFormInstance<CreateCrawlTaskFormValues>();
  const autoExpandDetailsEnabled = Boolean(
    Form.useWatch("autoExpandDetails", form),
  );

  return (
    <Card
      title={t("crawl.optimization.title")}
      size="small"
      style={{ marginBottom: 16 }}
    >
      <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
        {t("crawl.optimization.description")}
      </Typography.Paragraph>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message={t("crawl.optimization.noLlmTitle")}
        description={t("crawl.optimization.noLlmDescription")}
      />
      <Form.Item
        label={t("crawl.settings.qualityProfile")}
        name="qualityProfile"
        extra={t("crawl.settings.qualityProfileHint")}
      >
        <Select
          allowClear
          placeholder={t("crawl.settings.placeholders.qualityProfile")}
          options={[
            {
              value: "quality_first",
              label: t("crawl.settings.qualityProfileOptions.qualityFirst"),
            },
            {
              value: "balanced",
              label: t("crawl.settings.qualityProfileOptions.balanced"),
            },
            {
              value: "speed_first",
              label: t("crawl.settings.qualityProfileOptions.speedFirst"),
            },
          ]}
        />
      </Form.Item>
      <Form.Item
        label={t("crawl.settings.pageTypeHint")}
        name="pageTypeHint"
        extra={t("crawl.settings.pageTypeHintHint")}
      >
        <Select
          allowClear
          placeholder={t("crawl.settings.placeholders.pageTypeHint")}
          options={[
            {
              value: "auto",
              label: t("crawl.settings.pageTypeHintOptions.auto"),
            },
            {
              value: "list",
              label: t("crawl.settings.pageTypeHintOptions.list"),
            },
            {
              value: "detail",
              label: t("crawl.settings.pageTypeHintOptions.detail"),
            },
          ]}
        />
      </Form.Item>
      <Form.Item
        label={t("crawl.settings.autoExpandDetails")}
        name="autoExpandDetails"
        valuePropName="checked"
        extra={t("crawl.settings.autoExpandDetailsHint")}
      >
        <Switch
          onChange={(enabled) => {
            if (!enabled) {
              form.setFields([
                { name: ["detailExpansion"], value: undefined },
              ]);
              return;
            }
            const current = (form.getFieldValue(["detailExpansion"]) ??
              {}) as Record<string, unknown>;
            form.setFields([
              {
                name: ["detailExpansion", "maxDetailUrls"],
                value:
                  typeof current.maxDetailUrls === "number"
                    ? current.maxDetailUrls
                    : 8,
              },
              {
                name: ["detailExpansion", "minRelevanceScore"],
                value:
                  typeof current.minRelevanceScore === "number"
                    ? current.minRelevanceScore
                    : 0.2,
              },
              {
                name: ["detailExpansion", "requireSameDomain"],
                value:
                  typeof current.requireSameDomain === "boolean"
                    ? current.requireSameDomain
                    : true,
              },
              {
                name: ["detailExpansion", "allowExternalLinks"],
                value:
                  typeof current.allowExternalLinks === "boolean"
                    ? current.allowExternalLinks
                    : true,
              },
              {
                name: ["detailExpansion", "minPublishTimeConfidence"],
                value:
                  typeof current.minPublishTimeConfidence === "number"
                    ? current.minPublishTimeConfidence
                    : 0.55,
              },
              {
                name: ["detailExpansion", "preferFitMarkdownForQuality"],
                value:
                  typeof current.preferFitMarkdownForQuality === "boolean"
                    ? current.preferFitMarkdownForQuality
                    : true,
              },
            ]);
          }}
        />
      </Form.Item>
      {autoExpandDetailsEnabled ? (
        <>
          <Form.Item
            label={t("crawl.detailExpansion.maxDetailUrls")}
            name={["detailExpansion", "maxDetailUrls"]}
            extra={t("crawl.detailExpansion.maxDetailUrlsHint")}
          >
            <InputNumber min={1} max={30} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item
            label={t("crawl.detailExpansion.minRelevanceScore")}
            name={["detailExpansion", "minRelevanceScore"]}
            extra={t("crawl.detailExpansion.minRelevanceScoreHint")}
          >
            <InputNumber
              min={0}
              max={1}
              step={0.01}
              style={{ width: "100%" }}
            />
          </Form.Item>
          <Form.Item
            label={t("crawl.detailExpansion.requireSameDomain")}
            name={["detailExpansion", "requireSameDomain"]}
            valuePropName="checked"
            extra={t("crawl.detailExpansion.requireSameDomainHint")}
          >
            <Switch />
          </Form.Item>
          <Form.Item
            label={t("crawl.detailExpansion.allowExternalLinks")}
            name={["detailExpansion", "allowExternalLinks"]}
            valuePropName="checked"
            extra={t("crawl.detailExpansion.allowExternalLinksHint")}
          >
            <Switch />
          </Form.Item>
          <Form.Item
            label={t("crawl.detailExpansion.minPublishTimeConfidence")}
            name={["detailExpansion", "minPublishTimeConfidence"]}
            extra={t("crawl.detailExpansion.minPublishTimeConfidenceHint")}
          >
            <InputNumber
              min={0}
              max={1}
              step={0.01}
              style={{ width: "100%" }}
            />
          </Form.Item>
          <Form.Item
            label={t("crawl.detailExpansion.preferFitMarkdownForQuality")}
            name={["detailExpansion", "preferFitMarkdownForQuality"]}
            valuePropName="checked"
            extra={t(
              "crawl.detailExpansion.preferFitMarkdownForQualityHint",
            )}
          >
            <Switch />
          </Form.Item>
          <Form.Item
            label={t("crawl.detailExpansion.excludeUrlPatterns")}
            name={["detailExpansion", "excludeUrlPatterns"]}
            extra={t("crawl.detailExpansion.excludeUrlPatternsHint")}
          >
            <Select mode="tags" tokenSeparators={[","]} />
          </Form.Item>
          <Form.Item
            label={t("crawl.detailExpansion.includeUrlPatterns")}
            name={["detailExpansion", "includeUrlPatterns"]}
            extra={t("crawl.detailExpansion.includeUrlPatternsHint")}
          >
            <Select mode="tags" tokenSeparators={[","]} />
          </Form.Item>
        </>
      ) : null}
    </Card>
  );
}
