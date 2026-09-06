"use client";

/**
 * Create Crawl Task 抽屉的 markdown 领域（FE-批5B：自 CreateCrawlTaskDrawer.tsx 拆出）。
 * RAG 就绪提示、additionalUrls、markdownOptions、markdownFilter（pruning/bm25
 * 分支）、自定义 strategy（LLM 阻断 Alert + 校验）、cleanMarkdown 卡。
 */

import { Alert, Card, Form, Input, InputNumber, Select, Switch, Typography } from "antd";
import { useTranslation } from "react-i18next";

import type { CreateCrawlTaskFormValues } from "../../types";
import {
  hasBlockedCrawlLlmParams,
  hasBlockedCrawlLlmType,
  hasMarkdownStrategyLlmConfig,
} from "./option-guards";

export function MarkdownFields() {
  const { t } = useTranslation();
  const form = Form.useFormInstance<CreateCrawlTaskFormValues>();
  const markdownFilterType = Form.useWatch(["markdownFilter", "type"], form);
  const markdownStrategyTypeValue = Form.useWatch(
    ["markdownStrategy", "type"],
    form,
  );
  const markdownStrategyParamsValue = Form.useWatch(
    ["markdownStrategy", "params"],
    form,
  );
  const markdownStrategyHasLlmConfig = hasMarkdownStrategyLlmConfig({
    type:
      typeof markdownStrategyTypeValue === "string"
        ? markdownStrategyTypeValue
        : undefined,
    params:
      typeof markdownStrategyParamsValue === "string"
        ? markdownStrategyParamsValue
        : undefined,
  });

  return (
    <>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message={t("crawl.markdown.ragReadyTitle")}
        description={t("crawl.markdown.ragReadyHint")}
      />
      <Form.Item
        label={t("crawl.markdown.additionalUrls")}
        name="additionalUrls"
        extra={t("crawl.markdown.additionalUrlsHint")}
      >
        <Select
          mode="tags"
          tokenSeparators={[",", " "]}
          placeholder={t("crawl.markdown.placeholders.additionalUrls")}
          style={{ width: "100%" }}
        />
      </Form.Item>
      <Form.Item
        label={t("crawl.markdown.source")}
        name={["markdownOptions", "contentSource"]}
        extra={t("crawl.markdown.sourceHint")}
      >
        <Select
          allowClear
          placeholder={t("crawl.markdown.placeholders.source")}
          options={[
            {
              value: "cleaned_html",
              label: t("crawl.markdown.sourceOptions.cleaned"),
            },
            {
              value: "raw_html",
              label: t("crawl.markdown.sourceOptions.raw"),
            },
            {
              value: "fit_html",
              label: t("crawl.markdown.sourceOptions.fit"),
            },
          ]}
        />
      </Form.Item>
      <Form.Item
        label={t("crawl.markdown.ignoreLinks")}
        name={["markdownOptions", "ignoreLinks"]}
        valuePropName="checked"
        extra={t("crawl.markdown.ignoreLinksHint")}
      >
        <Switch />
      </Form.Item>
      <Form.Item
        label={t("crawl.markdown.escapeHtml")}
        name={["markdownOptions", "escapeHtml"]}
        valuePropName="checked"
        extra={t("crawl.markdown.escapeHtmlHint")}
      >
        <Switch />
      </Form.Item>
      <Form.Item
        label={t("crawl.markdown.citations")}
        name={["markdownOptions", "citations"]}
        valuePropName="checked"
        extra={t("crawl.markdown.citationsHint")}
      >
        <Switch />
      </Form.Item>
      <Form.Item
        label={t("crawl.markdown.bodyWidth")}
        name={["markdownOptions", "bodyWidth"]}
        extra={t("crawl.markdown.bodyWidthHint")}
      >
        <InputNumber
          min={40}
          max={200}
          placeholder={t("crawl.markdown.placeholders.bodyWidth")}
          style={{ width: "100%" }}
        />
      </Form.Item>
      <Form.Item
        label={t("crawl.markdown.filter")}
        name={["markdownFilter", "type"]}
        extra={t("crawl.markdown.filterHint")}
      >
        <Select
          allowClear
          placeholder={t("crawl.markdown.placeholders.filter")}
          options={[
            {
              value: "pruning",
              label: t("crawl.markdown.filterOptions.pruning"),
            },
            {
              value: "bm25",
              label: t("crawl.markdown.filterOptions.bm25"),
            },
          ]}
        />
      </Form.Item>
      <Form.Item
        label={t("crawl.markdown.pruningThreshold")}
        name={["markdownFilter", "threshold"]}
        hidden={markdownFilterType !== "pruning"}
        extra={t("crawl.markdown.pruningThresholdHint")}
      >
        <InputNumber
          min={0}
          max={1}
          step={0.05}
          style={{ width: "100%" }}
          placeholder={t("crawl.markdown.placeholders.pruningThreshold")}
        />
      </Form.Item>
      <Form.Item
        label={t("crawl.markdown.thresholdMode")}
        name={["markdownFilter", "thresholdType"]}
        hidden={markdownFilterType !== "pruning"}
        extra={t("crawl.markdown.thresholdModeHint")}
      >
        <Select
          allowClear
          placeholder={t("crawl.markdown.placeholders.thresholdMode")}
          options={[
            {
              value: "dynamic",
              label: t("crawl.markdown.thresholdModeOptions.dynamic"),
            },
            {
              value: "fixed",
              label: t("crawl.markdown.thresholdModeOptions.fixed"),
            },
          ]}
        />
      </Form.Item>
      <Form.Item
        label={t("crawl.markdown.minWords")}
        name={["markdownFilter", "minWordThreshold"]}
        hidden={markdownFilterType !== "pruning"}
        extra={t("crawl.markdown.minWordsHint")}
      >
        <InputNumber
          min={0}
          max={500}
          step={1}
          style={{ width: "100%" }}
          placeholder={t("crawl.markdown.placeholders.minWords")}
        />
      </Form.Item>
      <Form.Item
        label={t("crawl.markdown.bm25Query")}
        name={["markdownFilter", "userQuery"]}
        hidden={markdownFilterType !== "bm25"}
        extra={t("crawl.markdown.bm25QueryHint")}
        rules={
          markdownFilterType === "bm25"
            ? [
                {
                  required: true,
                  whitespace: true,
                  message: t("crawl.markdown.validation.bm25QueryRequired"),
                },
              ]
            : undefined
        }
      >
        <Input
          placeholder={t("crawl.markdown.placeholders.bm25Query")}
          maxLength={240}
        />
      </Form.Item>
      <Form.Item
        label={t("crawl.markdown.bm25Threshold")}
        name={["markdownFilter", "bm25Threshold"]}
        hidden={markdownFilterType !== "bm25"}
        extra={t("crawl.markdown.bm25ThresholdHint")}
      >
        <InputNumber
          min={0}
          max={20}
          step={0.1}
          style={{ width: "100%" }}
          placeholder={t("crawl.markdown.placeholders.bm25Threshold")}
        />
      </Form.Item>
      <Form.Item
        label={t("crawl.markdown.bm25Language")}
        name={["markdownFilter", "language"]}
        hidden={markdownFilterType !== "bm25"}
        extra={t("crawl.markdown.bm25LanguageHint")}
      >
        <Input
          placeholder={t("crawl.markdown.placeholders.bm25Language")}
          maxLength={32}
        />
      </Form.Item>
      <Typography.Title level={5} style={{ marginTop: 24 }}>
        {t("crawl.markdown.customStrategy.title")}
      </Typography.Title>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
        {t("crawl.markdown.customStrategy.description")}{" "}
        <Typography.Link
          href="https://github.com/unclecode/crawl4ai/blob/main/docs/md_v2/core/markdown-generation.md#custom-strategies"
          target="_blank"
          rel="noreferrer"
        >
          {t("crawl.markdown.customStrategy.linkText")}
        </Typography.Link>
        {t("crawl.markdown.customStrategy.trailing")}
      </Typography.Paragraph>
      {markdownStrategyHasLlmConfig ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 12 }}
          message={t("crawl.markdown.customStrategy.validation.noLlmExtraction")}
          description={t(
            "crawl.markdown.customStrategy.validation.noLlmExtractionHint",
          )}
        />
      ) : null}
      <Form.Item
        label={t("crawl.markdown.customStrategy.type")}
        name={["markdownStrategy", "type"]}
        extra={t("crawl.markdown.customStrategy.typeHint")}
        rules={[
          {
            validator: async (_, value) => {
              if (typeof value !== "string" || value.trim().length === 0) {
                return;
              }
              if (hasBlockedCrawlLlmType(value)) {
                throw new Error(
                  t("crawl.markdown.customStrategy.validation.noLlmExtraction"),
                );
              }
            },
          },
        ]}
      >
        <Input
          placeholder={t("crawl.markdown.customStrategy.placeholders.type")}
          maxLength={128}
        />
      </Form.Item>
      <Form.Item
        label={t("crawl.markdown.customStrategy.params")}
        name={["markdownStrategy", "params"]}
        extra={t("crawl.markdown.customStrategy.paramsHint")}
        rules={[
          {
            validator: async (_, value) => {
              if (typeof value !== "string" || value.trim().length === 0) {
                return;
              }
              try {
                JSON.parse(value);
              } catch {
                throw new Error(
                  t(
                    "crawl.markdown.customStrategy.validation.paramsMustBeJson",
                  ),
                );
              }
              if (hasBlockedCrawlLlmParams(value)) {
                throw new Error(
                  t("crawl.markdown.customStrategy.validation.noLlmExtraction"),
                );
              }
            },
          },
        ]}
      >
        <Input.TextArea
          rows={4}
          placeholder={t("crawl.markdown.customStrategy.placeholders.params")}
        />
      </Form.Item>
      <Card
        size="small"
        title={t("crawl.markdown.clean.title")}
        style={{ marginBottom: 16 }}
        extra={
          <Typography.Link
            href="https://github.com/unclecode/crawl4ai/blob/main/docs/md_v2/core/content-selection.md"
            target="_blank"
            rel="noreferrer"
          >
            {t("common.docs")}
          </Typography.Link>
        }
      >
        <Typography.Paragraph type="secondary" style={{ marginBottom: 16 }}>
          {t("crawl.markdown.clean.description")}{" "}
          <Typography.Link
            href="https://github.com/unclecode/crawl4ai/blob/main/docs/examples/quickstart.ipynb"
            target="_blank"
            rel="noreferrer"
          >
            {t("crawl.markdown.clean.linkText")}
          </Typography.Link>
          {t("crawl.markdown.clean.trailing")}
        </Typography.Paragraph>
        <Form.Item
          label={t("crawl.markdown.clean.cssSelector")}
          name={["cleanMarkdown", "cssSelector"]}
          extra={t("crawl.markdown.clean.cssSelectorHint")}
        >
          <Input
            placeholder={t("crawl.markdown.clean.placeholders.cssSelector")}
            maxLength={512}
          />
        </Form.Item>
        <Form.Item
          label={t("crawl.markdown.clean.targetElements")}
          name={["cleanMarkdown", "targetElements"]}
          extra={t("crawl.markdown.clean.targetElementsHint")}
        >
          <Select
            mode="tags"
            tokenSeparators={[",", " "]}
            placeholder={t("crawl.markdown.clean.placeholders.targetElements")}
            style={{ width: "100%" }}
          />
        </Form.Item>
        <Form.Item
          label={t("crawl.markdown.clean.excludedTags")}
          name={["cleanMarkdown", "excludedTags"]}
          extra={t("crawl.markdown.clean.excludedTagsHint")}
        >
          <Select
            mode="tags"
            tokenSeparators={[",", " "]}
            placeholder={t("crawl.markdown.clean.placeholders.excludedTags")}
            style={{ width: "100%" }}
          />
        </Form.Item>
        <Form.Item
          label={t("crawl.markdown.clean.removeOverlay")}
          name={["cleanMarkdown", "removeOverlayElements"]}
          valuePropName="checked"
        >
          <Switch />
        </Form.Item>
        <Form.Item
          label={t("crawl.markdown.clean.wordCount")}
          name={["cleanMarkdown", "wordCountThreshold"]}
          extra={t("crawl.markdown.clean.wordCountHint")}
        >
          <InputNumber
            min={0}
            max={2000}
            placeholder={t("crawl.markdown.clean.placeholders.wordCount")}
            style={{ width: "100%" }}
          />
        </Form.Item>
      </Card>
    </>
  );
}
