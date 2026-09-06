"use client";

/**
 * Create Crawl Task 抽屉的表格抽取卡（FE-批5B：自 CreateCrawlTaskDrawer.tsx 拆出）。
 */

import { Card, Form, Input, InputNumber, Typography } from "antd";
import { useTranslation } from "react-i18next";

export function TableExtractionFields() {
  const { t } = useTranslation();
  return (
    <Card
      size="small"
      title={t("crawl.tables.title")}
      style={{ marginBottom: 16 }}
      extra={
        <Typography.Link
          href="https://github.com/unclecode/crawl4ai/blob/main/docs/blog/release-v0.7.3.md"
          target="_blank"
          rel="noreferrer"
        >
          {t("common.docs")}
        </Typography.Link>
      }
    >
      <Typography.Paragraph type="secondary" style={{ marginBottom: 16 }}>
        {t("crawl.tables.description")}
      </Typography.Paragraph>
      <Form.Item
        label={t("crawl.tables.scoreThreshold")}
        name="tableScoreThreshold"
        extra={t("crawl.tables.scoreThresholdHint")}
      >
        <InputNumber
          min={0}
          max={10}
          step={0.1}
          placeholder={t("crawl.tables.placeholders.scoreThreshold")}
          style={{ width: "100%" }}
        />
      </Form.Item>
      <Form.Item
        label={t("crawl.tables.strategyType")}
        name={["tableExtraction", "type"]}
        extra={t("crawl.tables.strategyTypeHint")}
      >
        <Input
          placeholder={t("crawl.tables.placeholders.strategyType")}
          maxLength={128}
        />
      </Form.Item>
      <Form.Item
        label={t("crawl.tables.minRows")}
        name={["tableExtraction", "minRows"]}
        extra={t("crawl.tables.minRowsHint")}
      >
        <InputNumber
          min={1}
          max={1000}
          style={{ width: "100%" }}
          placeholder={t("crawl.tables.placeholders.minRows")}
        />
      </Form.Item>
      <Form.Item
        label={t("crawl.tables.minCols")}
        name={["tableExtraction", "minCols"]}
        extra={t("crawl.tables.minColsHint")}
      >
        <InputNumber
          min={1}
          max={50}
          style={{ width: "100%" }}
          placeholder={t("crawl.tables.placeholders.minCols")}
        />
      </Form.Item>
      <Form.Item
        label={t("crawl.tables.extraParams")}
        name={["tableExtraction", "params"]}
        extra={t("crawl.tables.extraParamsHint")}
      >
        <Input.TextArea
          rows={3}
          placeholder={t("crawl.tables.placeholders.extraParams")}
        />
      </Form.Item>
    </Card>
  );
}
