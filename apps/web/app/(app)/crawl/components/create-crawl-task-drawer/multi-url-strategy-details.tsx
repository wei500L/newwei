"use client";

/**
 * Create Crawl Task 抽屉的 multi URL 策略详情展开（FE-批5B：自
 * CreateCrawlTaskDrawer.tsx 拆出）。策略级 autoExpandDetails 开关与
 * detailExpansion 条件字段组（shouldUpdate 派生，嵌套路径不与根级共享错误 path）。
 */

import type { FormListFieldData } from "antd";
import { Form, InputNumber, Select, Switch } from "antd";
import { useTranslation } from "react-i18next";

import type { CreateCrawlTaskFormValues } from "../../types";

export interface MultiUrlStrategyDetailsProps {
  field: FormListFieldData;
}

export function MultiUrlStrategyDetails({
  field,
}: MultiUrlStrategyDetailsProps) {
  const { t } = useTranslation();
  const form = Form.useFormInstance<CreateCrawlTaskFormValues>();
  return (
    <>
      <Form.Item
        label={t("crawl.settings.autoExpandDetails")}
        name={[field.name, "options", "autoExpandDetails"]}
        valuePropName="checked"
      >
        <Switch
          onChange={(enabled) => {
            if (!enabled) {
              form.setFields([
                {
                  name: [
                    "multiUrlConfigs",
                    field.name,
                    "options",
                    "detailExpansion",
                  ],
                  value: undefined,
                },
              ]);
            }
          }}
        />
      </Form.Item>
      <Form.Item
        noStyle
        shouldUpdate={(prev, next) => {
          const prevEnabled =
            prev?.multiUrlConfigs?.[field.name]?.options?.autoExpandDetails;
          const nextEnabled =
            next?.multiUrlConfigs?.[field.name]?.options?.autoExpandDetails;
          return prevEnabled !== nextEnabled;
        }}
      >
        {() => {
          const enabled = Boolean(
            form.getFieldValue([
              "multiUrlConfigs",
              field.name,
              "options",
              "autoExpandDetails",
            ]),
          );
          if (!enabled) {
            return null;
          }
          return (
            <>
              <Form.Item
                label={t("crawl.detailExpansion.maxDetailUrls")}
                name={[
                  field.name,
                  "options",
                  "detailExpansion",
                  "maxDetailUrls",
                ]}
                extra={t("crawl.detailExpansion.maxDetailUrlsHint")}
              >
                <InputNumber min={1} max={30} style={{ width: "100%" }} />
              </Form.Item>
              <Form.Item
                label={t("crawl.detailExpansion.minRelevanceScore")}
                name={[
                  field.name,
                  "options",
                  "detailExpansion",
                  "minRelevanceScore",
                ]}
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
                name={[
                  field.name,
                  "options",
                  "detailExpansion",
                  "requireSameDomain",
                ]}
                valuePropName="checked"
                extra={t("crawl.detailExpansion.requireSameDomainHint")}
              >
                <Switch />
              </Form.Item>
              <Form.Item
                label={t("crawl.detailExpansion.allowExternalLinks")}
                name={[
                  field.name,
                  "options",
                  "detailExpansion",
                  "allowExternalLinks",
                ]}
                valuePropName="checked"
                extra={t("crawl.detailExpansion.allowExternalLinksHint")}
              >
                <Switch />
              </Form.Item>
              <Form.Item
                label={t("crawl.detailExpansion.minPublishTimeConfidence")}
                name={[
                  field.name,
                  "options",
                  "detailExpansion",
                  "minPublishTimeConfidence",
                ]}
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
                name={[
                  field.name,
                  "options",
                  "detailExpansion",
                  "preferFitMarkdownForQuality",
                ]}
                valuePropName="checked"
                extra={t(
                  "crawl.detailExpansion.preferFitMarkdownForQualityHint",
                )}
              >
                <Switch />
              </Form.Item>
              <Form.Item
                label={t("crawl.detailExpansion.excludeUrlPatterns")}
                name={[
                  field.name,
                  "options",
                  "detailExpansion",
                  "excludeUrlPatterns",
                ]}
                extra={t("crawl.detailExpansion.excludeUrlPatternsHint")}
              >
                <Select mode="tags" tokenSeparators={[","]} />
              </Form.Item>
              <Form.Item
                label={t("crawl.detailExpansion.includeUrlPatterns")}
                name={[
                  field.name,
                  "options",
                  "detailExpansion",
                  "includeUrlPatterns",
                ]}
                extra={t("crawl.detailExpansion.includeUrlPatternsHint")}
              >
                <Select mode="tags" tokenSeparators={[","]} />
              </Form.Item>
            </>
          );
        }}
      </Form.Item>
    </>
  );
}
