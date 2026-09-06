"use client";

/**
 * Create Crawl Task 抽屉的链接预览卡（FE-批5B：自 CreateCrawlTaskDrawer.tsx 拆出）。
 * scoreLinks 总开关开启前，Link Preview 相关项全部禁用。
 */

import { Card, Form, Input, InputNumber, Select, Switch, Typography } from "antd";
import { useTranslation } from "react-i18next";

import type { CreateCrawlTaskFormValues } from "../../types";

export function LinkPreviewFields() {
  const { t } = useTranslation();
  const form = Form.useFormInstance<CreateCrawlTaskFormValues>();
  const scoreLinksValue = Form.useWatch("scoreLinks", form);
  const linkPreviewDisabled = !scoreLinksValue;

  return (
    <Card
      size="small"
      title={t("crawl.links.title")}
      style={{ marginBottom: 16 }}
    >
      <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
        {t("crawl.links.description")}
      </Typography.Paragraph>
      <Form.Item
        label={t("crawl.links.scoreLinks")}
        name="scoreLinks"
        valuePropName="checked"
        extra={t("crawl.links.scoreLinksHint")}
      >
        <Switch />
      </Form.Item>
      <Form.Item
        label={t("crawl.links.includeInternal")}
        name={["linkPreview", "includeInternal"]}
        valuePropName="checked"
      >
        <Switch disabled={linkPreviewDisabled} />
      </Form.Item>
      <Form.Item
        label={t("crawl.links.includeExternal")}
        name={["linkPreview", "includeExternal"]}
        valuePropName="checked"
      >
        <Switch disabled={linkPreviewDisabled} />
      </Form.Item>
      <Form.Item
        label={t("crawl.links.includeSocial")}
        name={["linkPreview", "includeSocial"]}
        valuePropName="checked"
      >
        <Switch disabled={linkPreviewDisabled} />
      </Form.Item>
      <Form.Item
        label={t("crawl.links.maxLinks")}
        name={["linkPreview", "maxLinks"]}
      >
        <InputNumber
          min={1}
          max={500}
          style={{ width: "100%" }}
          placeholder={t("crawl.links.placeholders.maxLinks")}
          disabled={linkPreviewDisabled}
        />
      </Form.Item>
      <Form.Item
        label={t("crawl.links.concurrency")}
        name={["linkPreview", "concurrency"]}
      >
        <InputNumber
          min={1}
          max={50}
          style={{ width: "100%" }}
          placeholder={t("crawl.links.placeholders.concurrency")}
          disabled={linkPreviewDisabled}
        />
      </Form.Item>
      <Form.Item
        label={t("crawl.links.timeout")}
        name={["linkPreview", "timeoutSeconds"]}
      >
        <InputNumber
          min={1}
          max={60}
          style={{ width: "100%" }}
          placeholder={t("crawl.links.placeholders.timeout")}
          disabled={linkPreviewDisabled}
        />
      </Form.Item>
      <Form.Item
        label={t("crawl.links.contextQuery")}
        name={["linkPreview", "query"]}
      >
        <Input
          placeholder={t("crawl.links.placeholders.contextQuery")}
          disabled={linkPreviewDisabled}
        />
      </Form.Item>
      <Form.Item
        label={t("crawl.links.scoreThreshold")}
        name={["linkPreview", "scoreThreshold"]}
      >
        <InputNumber
          min={0}
          max={1}
          step={0.05}
          style={{ width: "100%" }}
          placeholder={t("crawl.links.placeholders.scoreThreshold")}
          disabled={linkPreviewDisabled}
        />
      </Form.Item>
      <Form.Item
        label={t("crawl.links.verbose")}
        name={["linkPreview", "verbose"]}
        valuePropName="checked"
      >
        <Switch disabled={linkPreviewDisabled} />
      </Form.Item>
      <Form.Item
        label={t("crawl.links.includePatterns")}
        name={["linkPreview", "includePatterns"]}
      >
        <Select
          mode="tags"
          tokenSeparators={[",", " "]}
          placeholder={t("crawl.links.placeholders.includePatterns")}
          disabled={linkPreviewDisabled}
        />
      </Form.Item>
      <Form.Item
        label={t("crawl.links.excludePatterns")}
        name={["linkPreview", "excludePatterns"]}
      >
        <Select
          mode="tags"
          tokenSeparators={[",", " "]}
          placeholder={t("crawl.links.placeholders.excludePatterns")}
          disabled={linkPreviewDisabled}
        />
      </Form.Item>
    </Card>
  );
}
