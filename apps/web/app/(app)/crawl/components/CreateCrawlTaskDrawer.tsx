"use client";

import {
  GlobalOutlined,
  MinusCircleOutlined,
  PlusOutlined,
  ReadOutlined,
  RobotOutlined,
  TeamOutlined,
} from "@ant-design/icons";
import {
  Alert,
  Button,
  Card,
  Col,
  DatePicker,
  Drawer,
  Form,
  Input,
  InputNumber,
  Row,
  Select,
  Space,
  Steps,
  Switch,
  Typography,
} from "antd";
import type { FormInstance } from "antd/es/form";
import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import dayjs from "@/lib/dayjs";

import type { CreateCrawlTaskFormValues } from "../types";

interface CreateCrawlTaskDrawerProps {
  form: FormInstance<CreateCrawlTaskFormValues>;
  open: boolean;
  loading: boolean;
  canWriteItems: boolean;
  title?: ReactNode;
  submitLabel?: ReactNode;
  defaultTemplateKey?: string;
  onClose: () => void;
  onSubmit: (values: CreateCrawlTaskFormValues) => void | Promise<void>;
}

const TEMPLATES = [
  {
    key: "general",
    icon: <GlobalOutlined />,
    label: "crawl.templates.general",
    description: "crawl.templates.generalDesc",
  },
  {
    key: "news",
    icon: <ReadOutlined />,
    label: "crawl.templates.news",
    description: "crawl.templates.newsDesc",
  },
  {
    key: "forum",
    icon: <TeamOutlined />,
    label: "crawl.templates.forum",
    description: "crawl.templates.forumDesc",
  },
  {
    key: "social",
    icon: <RobotOutlined />,
    label: "crawl.templates.social",
    description: "crawl.templates.socialDesc",
  },
];

const normalizeOptionGuardKey = (value: string) =>
  value.toLowerCase().replace(/[^a-z0-9]/g, "");

const hasBlockedCrawlLlmType = (value?: string) => {
  if (!value) {
    return false;
  }
  const normalized = normalizeOptionGuardKey(value);
  if (!normalized.includes("llm")) {
    return false;
  }
  return (
    normalized.includes("strategy") ||
    normalized.includes("extraction") ||
    normalized.includes("llm")
  );
};

const hasBlockedCrawlLlmParams = (rawText?: string) => {
  if (!rawText || !rawText.trim()) {
    return false;
  }
  try {
    const parsed = JSON.parse(rawText);
    const visited = new Set<unknown>();
    const walk = (value: unknown, prefix = ""): boolean => {
      if (!value || typeof value !== "object") {
        return false;
      }
      if (visited.has(value)) {
        return false;
      }
      visited.add(value);

      if (Array.isArray(value)) {
        return value.some((entry, index) => walk(entry, prefix + "[" + index + "]"));
      }

      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        const normalizedKey = normalizeOptionGuardKey(key);
        const path = prefix ? prefix + "." + key : key;

        if (normalizedKey === "extractionstrategy" || normalizedKey === "llmconfig") {
          return true;
        }

        if (
          normalizedKey === "type" &&
          typeof entry === "string" &&
          hasBlockedCrawlLlmType(entry) &&
          /strategy|extraction/i.test(path)
        ) {
          return true;
        }

        if (walk(entry, path)) {
          return true;
        }
      }

      return false;
    };

    return walk(parsed);
  } catch {
    return false;
  }
};

export function CreateCrawlTaskDrawer({
  form,
  open,
  loading,
  canWriteItems,
  title,
  submitLabel,
  defaultTemplateKey,
  onClose,
  onSubmit,
}: CreateCrawlTaskDrawerProps) {
  const { t } = useTranslation();
  const [currentStep, setCurrentStep] = useState(0);
  const [selectedTemplate, setSelectedTemplate] = useState("general");

  const scanFullPage = Form.useWatch("scanFullPage", form);
  const proxyUrlValue = Form.useWatch("proxyUrl", form);
  const proxyConfigValue = Form.useWatch("proxyConfig", form);
  const markdownFilterType = Form.useWatch(["markdownFilter", "type"], form);
  const scoreLinksValue = Form.useWatch("scoreLinks", form);
  const userAgentModeValue = Form.useWatch("userAgentMode", form);
  const useManagedBrowserValue = Form.useWatch("useManagedBrowser", form);

  const proxyUrlActive = Boolean(proxyUrlValue?.trim().length);
  const proxyObjectActive = Boolean(proxyConfigValue?.server?.trim().length);
  const linkPreviewDisabled = !scoreLinksValue;

  const handleNext = async () => {
    try {
      if (currentStep === 1) {
        await form.validateFields(["displayName", "url"]);
      }
      setCurrentStep(currentStep + 1);
    } catch {
      // Validation failed
    }
  };

  const handlePrev = () => {
    setCurrentStep(currentStep - 1);
  };

  const handleTemplateSelect = useCallback((templateKey: string) => {
    setSelectedTemplate(templateKey);
    // Set default values based on template
    switch (templateKey) {
      case "general":
        form.setFieldsValue({
          ingestToItems: false,
          onlyMainContent: true,
          scanFullPage: false,
          extractLinks: false,
        });
        break;
      case "news":
        form.setFieldsValue({
          ingestToItems: canWriteItems ? true : false,
          onlyMainContent: true,
          extractLinks: false,
          scanFullPage: false,
          adjustViewportToContent: true,
          scrollDelayMs: 200,
          includeImages: true,
          excludeExternalImages: false,
          waitForImages: true,
          simulateUser: true,
          overrideNavigator: true,
          markdownOptions: {
            contentSource: "cleaned_html",
            escapeHtml: true,
            bodyWidth: 80,
          },
          markdownFilter: { type: "pruning", thresholdType: "dynamic", minWordThreshold: 80 },
          cleanMarkdown: {
            cssSelector: "article,main,.article-body",
            removeOverlayElements: true,
            wordCountThreshold: 120,
            excludedTags: ["nav", "footer", "script", "style"],
          },
        });
        break;
      case "forum":
        form.setFieldsValue({
          ingestToItems: false,
          onlyMainContent: false,
          scanFullPage: true,
          extractLinks: false,
          scrollDelayMs: 1000,
        });
        break;
      case "social":
        form.setFieldsValue({
          ingestToItems: false,
          headless: false,
          enableStealthMode: true,
          enableUndetectedBrowser: true,
          scanFullPage: true,
          onlyMainContent: false,
          waitForTimeoutMs: 5000,
          scrollDelayMs: 2000,
          userAgentMode: "random",
        });
        break;
    }
  }, [canWriteItems, form]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const normalizedKey = defaultTemplateKey?.trim();
    if (!normalizedKey) {
      return;
    }
    if (normalizedKey === selectedTemplate) {
      return;
    }
    const exists = TEMPLATES.some((template) => template.key === normalizedKey);
    if (!exists) {
      return;
    }
    handleTemplateSelect(normalizedKey);
  }, [defaultTemplateKey, handleTemplateSelect, open, selectedTemplate]);

  const resetAndClose = () => {
    setCurrentStep(0);
    onClose();
  };

  return (
    <Drawer
      title={title ?? t("crawl.createDrawer.title")}
      placement="right"
      width={600}
      open={open}
      onClose={resetAndClose}
      destroyOnHidden
      extra={
        <Space>
          <Button onClick={resetAndClose}>{t("common.cancel")}</Button>
        </Space>
      }
    >
      <Steps
        current={currentStep}
        items={[
          { title: t("crawl.steps.template") },
          { title: t("crawl.steps.basic") },
          { title: t("crawl.steps.advanced") },
        ]}
        style={{ marginBottom: 24 }}
      />

      <Form layout="vertical" form={form} onFinish={onSubmit}>
        <div style={{ display: currentStep === 0 ? "block" : "none" }}>
          <Typography.Title level={5}>{t("crawl.templates.selectTitle")}</Typography.Title>
          <Row gutter={[16, 16]}>
            {TEMPLATES.map((template) => (
              <Col span={12} key={template.key}>
                <Card
                  hoverable
                  onClick={() => handleTemplateSelect(template.key)}
                  className={selectedTemplate === template.key ? "border-primary" : ""}
                  style={{
                    borderColor: selectedTemplate === template.key ? "#1677ff" : undefined,
                    borderWidth: selectedTemplate === template.key ? 2 : 1,
                    height: "100%",
                  }}
                >
                  <Space direction="vertical" align="center" style={{ width: "100%" }}>
                    <div style={{ fontSize: 24, color: "#1677ff" }}>{template.icon}</div>
                    <Typography.Text strong>{t(template.label)}</Typography.Text>
                    <Typography.Text type="secondary" style={{ fontSize: 12, textAlign: 'center' }}>
                      {t(template.description)}
                    </Typography.Text>
                  </Space>
                </Card>
              </Col>
            ))}
          </Row>
        </div>

        <div style={{ display: currentStep === 1 ? "block" : "none" }}>
          <Form.Item
            label={t("crawl.settings.displayName")}
            name="displayName"
            rules={[{ max: 80, message: t("crawl.settings.validation.displayNameMax", { count: 80 }) }]}
          >
            <Input placeholder={t("crawl.settings.placeholders.displayName")} />
          </Form.Item>
          <Form.Item
            label={t("crawl.settings.targetUrl")}
            name="url"
            rules={[{ required: true, message: t("crawl.settings.validation.urlRequired") }]}
          >
            <Input placeholder={t("crawl.settings.placeholders.url")} />
          </Form.Item>
        </div>

        <div style={{ display: currentStep === 2 ? "block" : "none" }}>
          <CrawlSettingsForm
            scanFullPage={scanFullPage}
            markdownFilterType={markdownFilterType}
            linkPreviewDisabled={linkPreviewDisabled}
            canWriteItems={canWriteItems}
          />
          <BrowserConfigForm
            userAgentModeValue={userAgentModeValue}
            useManagedBrowserValue={useManagedBrowserValue}
            proxyUrlActive={proxyUrlActive}
            proxyObjectActive={proxyObjectActive}
          />
        </div>

        <div style={{ marginTop: 24, display: "flex", justifyContent: "space-between" }}>
          {currentStep > 0 && (
            <Button onClick={handlePrev}>
              {t("common.previous")}
            </Button>
          )}
          <div style={{ marginLeft: "auto" }}>
             {currentStep < 2 && (
              <Button type="primary" onClick={handleNext}>
                {t("common.next")}
              </Button>
            )}
            {currentStep === 2 && (
              <Button type="primary" htmlType="submit" loading={loading}>
                {submitLabel ?? t("crawl.createDrawer.submit")}
              </Button>
            )}
          </div>
        </div>
      </Form>
    </Drawer>
  );
}

interface CrawlSettingsFormProps {
  scanFullPage?: boolean;
  markdownFilterType?: string;
  linkPreviewDisabled: boolean;
  canWriteItems: boolean;
}

function CrawlSettingsForm({
  scanFullPage,
  markdownFilterType,
  linkPreviewDisabled,
  canWriteItems,
}: CrawlSettingsFormProps) {
  const { t } = useTranslation();
  const form = Form.useFormInstance<CreateCrawlTaskFormValues>();
  const virtualScrollEnabled = Boolean(Form.useWatch(["virtualScroll", "enabled"], form));
  const virtualScrollScrollByValue = Form.useWatch(["virtualScroll", "scrollBy"], form);
  const markdownStrategyTypeValue = Form.useWatch(["markdownStrategy", "type"], form);
  const markdownStrategyParamsValue = Form.useWatch(["markdownStrategy", "params"], form);
  const markdownStrategyHasLlmConfig =
    hasBlockedCrawlLlmType(
      typeof markdownStrategyTypeValue === "string" ? markdownStrategyTypeValue : undefined,
    ) ||
    hasBlockedCrawlLlmParams(
      typeof markdownStrategyParamsValue === "string"
        ? markdownStrategyParamsValue
        : undefined,
    );
  const ingestHint = canWriteItems
    ? t("crawl.settings.ingestToItemsHint", {
        defaultValue: "New crawl results will be converted into Items and queued for LLM processing."
      })
    : t("crawl.settings.ingestToItemsNoPermission", { defaultValue: "Requires items.write permission." });
  return (
    <>
      {/* Moved displayName and url to Step 1 */}
      
      <Form.Item
        label={t("crawl.settings.ingestToItems", { defaultValue: "Auto send to Items" })}
        name="ingestToItems"
        valuePropName="checked"
        extra={ingestHint}
      >
        <Switch disabled={!canWriteItems} />
      </Form.Item>
      <Form.Item label={t("crawl.settings.keywords")} name="keywords">
        <Select mode="tags" placeholder={t("crawl.settings.placeholders.keywords")} />
      </Form.Item>
      <Form.Item label={t("crawl.settings.timeRange")} name="timeRange">
        <DatePicker.RangePicker
          allowClear
          showTime
          style={{ width: "100%" }}
          disabledDate={(date) => date && date > dayjs()}
        />
      </Form.Item>
      <Form.Item label={t("crawl.settings.concurrency")} name="concurrency">
        <InputNumber
          min={1}
          max={10}
          style={{ width: "100%" }}
          placeholder={t("crawl.settings.placeholders.concurrency")}
        />
      </Form.Item>
      <Form.Item
        label={t("crawl.settings.includeImages")}
        name="includeImages"
        valuePropName="checked"
      >
        <Switch />
      </Form.Item>
      <Form.Item
        label={t("crawl.settings.storeMedia")}
        name="storeMedia"
        valuePropName="checked"
        extra={t("crawl.settings.storeMediaHint")}
      >
        <Switch />
      </Form.Item>
      <Form.Item
        label={t("crawl.settings.onlyMainContent")}
        name="onlyMainContent"
        valuePropName="checked"
      >
        <Switch defaultChecked />
      </Form.Item>
      <Form.Item
        label={t("crawl.settings.extractLinks")}
        name="extractLinks"
        valuePropName="checked"
      >
        <Switch />
      </Form.Item>
      <Form.Item
        label={t("crawl.settings.excludeExternalImages")}
        name="excludeExternalImages"
        valuePropName="checked"
        extra={t("crawl.settings.excludeExternalImagesHint")}
      >
        <Switch />
      </Form.Item>
      <Form.Item
        label={t("crawl.settings.waitForImages")}
        name="waitForImages"
        valuePropName="checked"
        extra={t("crawl.settings.waitForImagesHint")}
      >
        <Switch />
      </Form.Item>
      <Form.Item
        label={t("crawl.settings.scanFullPage")}
        name="scanFullPage"
        valuePropName="checked"
      >
        <Switch disabled={virtualScrollEnabled} />
      </Form.Item>
      <Form.Item label={t("crawl.settings.scrollDelay")} name="scrollDelayMs">
        <InputNumber
          min={0}
          max={5000}
          style={{ width: "100%" }}
          placeholder={t("crawl.settings.placeholders.scrollDelay")}
          disabled={!scanFullPage || virtualScrollEnabled}
        />
      </Form.Item>
      <Card
        title={t("crawl.virtualScroll.title")}
        size="small"
        style={{ marginBottom: 16 }}
        extra={
          <Typography.Link
            href="https://github.com/unclecode/crawl4ai/blob/main/docs/md_v2/advanced/virtual-scroll.md"
            target="_blank"
            rel="noreferrer"
          >
            {t("common.docs")}
          </Typography.Link>
        }
      >
        <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
          {t("crawl.virtualScroll.description")}
        </Typography.Paragraph>
        <Form.Item
          label={t("crawl.virtualScroll.enable")}
          name={["virtualScroll", "enabled"]}
          valuePropName="checked"
        >
          <Switch
            onChange={(enabled) => {
              if (!enabled) {
                form.setFields([{ name: ["virtualScroll"], value: undefined }]);
                return;
              }
              const current = (form.getFieldValue(["virtualScroll"]) ?? {}) as Record<
                string,
                unknown
              >;
              const containerSelector =
                typeof current.containerSelector === "string" && current.containerSelector.trim().length
                  ? current.containerSelector
                  : "body";
              const scrollCount =
                typeof current.scrollCount === "number" && Number.isFinite(current.scrollCount)
                  ? current.scrollCount
                  : 10;
              const scrollBy =
                typeof current.scrollBy === "string" && current.scrollBy.length ? current.scrollBy : "page_height";
              const scrollByPixels =
                typeof current.scrollByPixels === "number" && Number.isFinite(current.scrollByPixels)
                  ? current.scrollByPixels
                  : 500;
              const waitAfterScrollMs =
                typeof current.waitAfterScrollMs === "number" && Number.isFinite(current.waitAfterScrollMs)
                  ? current.waitAfterScrollMs
                  : 600;
              form.setFields([
                { name: ["scanFullPage"], value: false },
                { name: ["scrollDelayMs"], value: undefined },
                { name: ["virtualScroll", "enabled"], value: true },
                { name: ["virtualScroll", "containerSelector"], value: containerSelector },
                { name: ["virtualScroll", "scrollCount"], value: scrollCount },
                { name: ["virtualScroll", "scrollBy"], value: scrollBy },
                { name: ["virtualScroll", "scrollByPixels"], value: scrollByPixels },
                { name: ["virtualScroll", "waitAfterScrollMs"], value: waitAfterScrollMs }
              ]);
            }}
          />
        </Form.Item>
        {virtualScrollEnabled ? (
          <>
            <Form.Item
              label={t("crawl.virtualScroll.containerSelector")}
              name={["virtualScroll", "containerSelector"]}
              extra={t("crawl.virtualScroll.containerSelectorHint")}
            >
              <Input placeholder="body" />
            </Form.Item>
            <Form.Item
              label={t("crawl.virtualScroll.scrollCount")}
              name={["virtualScroll", "scrollCount"]}
              extra={t("crawl.virtualScroll.scrollCountHint")}
            >
              <InputNumber min={1} max={1000} style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item
              label={t("crawl.virtualScroll.scrollBy")}
              name={["virtualScroll", "scrollBy"]}
              extra={t("crawl.virtualScroll.scrollByHint")}
            >
              <Select
                allowClear
                options={[
                  { value: "page_height", label: t("crawl.virtualScroll.scrollByOptions.pageHeight") },
                  { value: "container_height", label: t("crawl.virtualScroll.scrollByOptions.containerHeight") },
                  { value: "pixels", label: t("crawl.virtualScroll.scrollByOptions.pixels") }
                ]}
              />
            </Form.Item>
            {virtualScrollScrollByValue === "pixels" ? (
              <Form.Item
                label={t("crawl.virtualScroll.scrollByPixels")}
                name={["virtualScroll", "scrollByPixels"]}
                extra={t("crawl.virtualScroll.scrollByPixelsHint")}
              >
                <InputNumber min={1} max={20000} step={50} style={{ width: "100%" }} />
              </Form.Item>
            ) : null}
            <Form.Item
              label={t("crawl.virtualScroll.waitAfterScroll")}
              name={["virtualScroll", "waitAfterScrollMs"]}
              extra={t("crawl.virtualScroll.waitAfterScrollHint")}
            >
              <InputNumber min={0} max={60000} step={100} style={{ width: "100%" }} />
            </Form.Item>
            {scanFullPage ? (
              <Typography.Text type="secondary" style={{ display: "block" }}>
                {t("crawl.virtualScroll.scanFullPageHint")}
              </Typography.Text>
            ) : null}
          </>
        ) : null}
      </Card>
      <Form.Item
        label={t("crawl.settings.adjustViewport")}
        name="adjustViewportToContent"
        valuePropName="checked"
        extra={
          <span>
            {t("crawl.settings.adjustViewportHint")}{" "}
            <Typography.Link
              href="https://github.com/unclecode/crawl4ai/blob/main/docs/md_v2/blog/releases/0.4.1.md"
              target="_blank"
              rel="noreferrer"
            >
              {t("crawl.settings.adjustViewportLink")}
            </Typography.Link>
            {t("common.punctuation.period")}
          </span>
        }
      >
        <Switch />
      </Form.Item>
      <Form.Item
        label={t("crawl.settings.simulateUser")}
        name="simulateUser"
        valuePropName="checked"
        extra={t("crawl.settings.simulateUserHint")}
      >
        <Switch />
      </Form.Item>
      <Form.Item
        label={t("crawl.settings.overrideNavigator")}
        name="overrideNavigator"
        valuePropName="checked"
        extra={t("crawl.settings.overrideNavigatorHint")}
      >
        <Switch />
      </Form.Item>
      <Card
        title={t("crawl.dynamic.title")}
        size="small"
        style={{ marginBottom: 16 }}
        extra={
          <Typography.Link
            href="https://github.com/unclecode/crawl4ai/blob/main/docs/md_v2/advanced/session-management.md"
            target="_blank"
            rel="noreferrer"
          >
            {t("common.docs")}
          </Typography.Link>
        }
      >
        <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
          {t("crawl.dynamic.description")}
        </Typography.Paragraph>
        <Form.List name="jsCode">
          {(fields, { add, remove }) => (
            <Space direction="vertical" style={{ width: "100%" }}>
              {fields.map((field, index) => (
                <Space key={field.key} align="start">
                  <Form.Item
                    {...field}
                    label={t("crawl.dynamic.jsStep", { index: index + 1 })}
                    style={{ flex: 1 }}
                    rules={[
                      { required: true, message: t("crawl.dynamic.jsRequired") },
                    ]}
                  >
                    <Input.TextArea
                      rows={3}
                      placeholder={t("crawl.dynamic.placeholders.jsSnippet")}
                    />
                  </Form.Item>
                  <Button
                    type="link"
                    danger
                    icon={<MinusCircleOutlined />}
                    onClick={() => remove(field.name)}
                  />
                </Space>
              ))}
              <Button
                type="dashed"
                onClick={() => add()}
                icon={<PlusOutlined />}
                block
              >
                {t("crawl.dynamic.addJsStep")}
              </Button>
            </Space>
          )}
        </Form.List>
        <Form.Item
          label={t("crawl.dynamic.jsOnly")}
          name="jsOnly"
          valuePropName="checked"
          extra={t("crawl.dynamic.jsOnlyHint")}
        >
          <Switch />
        </Form.Item>
        <Form.Item
          label={t("crawl.dynamic.waitForSelector")}
          name="waitForSelector"
          extra={t("crawl.dynamic.waitForSelectorHint")}
        >
          <Input placeholder={t("crawl.dynamic.placeholders.selector")} />
        </Form.Item>
        <Form.Item
          label={t("crawl.dynamic.waitForScript")}
          name="waitForScript"
          extra={t("crawl.dynamic.waitForScriptHint")}
        >
          <Input.TextArea
            rows={3}
            placeholder={t("crawl.dynamic.placeholders.script")}
          />
        </Form.Item>
        <Form.Item
          label={t("crawl.dynamic.waitTimeout")}
          name="waitForTimeoutMs"
          extra={t("crawl.dynamic.waitTimeoutHint")}
        >
          <InputNumber
            min={500}
            max={60000}
            style={{ width: "100%" }}
            placeholder={t("crawl.dynamic.placeholders.waitTimeout")}
          />
        </Form.Item>
      </Card>
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
            { value: "cleaned_html", label: t("crawl.markdown.sourceOptions.cleaned") },
            { value: "raw_html", label: t("crawl.markdown.sourceOptions.raw") },
            { value: "fit_html", label: t("crawl.markdown.sourceOptions.fit") },
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
            { value: "pruning", label: t("crawl.markdown.filterOptions.pruning") },
            { value: "bm25", label: t("crawl.markdown.filterOptions.bm25") },
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
            { value: "dynamic", label: t("crawl.markdown.thresholdModeOptions.dynamic") },
            { value: "fixed", label: t("crawl.markdown.thresholdModeOptions.fixed") },
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
        <Input placeholder={t("crawl.markdown.placeholders.bm25Query")} maxLength={240} />
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
        <Input placeholder={t("crawl.markdown.placeholders.bm25Language")} maxLength={32} />
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
          description={t("crawl.markdown.customStrategy.validation.noLlmExtractionHint")}
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
        <Input placeholder={t("crawl.markdown.customStrategy.placeholders.type")} maxLength={128} />
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
                  t("crawl.markdown.customStrategy.validation.paramsMustBeJson"),
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
          <Input placeholder={t("crawl.markdown.clean.placeholders.cssSelector")} maxLength={512} />
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
          <Input placeholder={t("crawl.tables.placeholders.strategyType")} maxLength={128} />
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
      <Card size="small" title={t("crawl.links.title")} style={{ marginBottom: 16 }}>
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
        <Form.Item label={t("crawl.links.maxLinks")} name={["linkPreview", "maxLinks"]}>
          <InputNumber
            min={1}
            max={500}
            style={{ width: "100%" }}
            placeholder={t("crawl.links.placeholders.maxLinks")}
            disabled={linkPreviewDisabled}
          />
        </Form.Item>
        <Form.Item label={t("crawl.links.concurrency")} name={["linkPreview", "concurrency"]}>
          <InputNumber
            min={1}
            max={50}
            style={{ width: "100%" }}
            placeholder={t("crawl.links.placeholders.concurrency")}
            disabled={linkPreviewDisabled}
          />
        </Form.Item>
        <Form.Item label={t("crawl.links.timeout")} name={["linkPreview", "timeoutSeconds"]}>
          <InputNumber
            min={1}
            max={60}
            style={{ width: "100%" }}
            placeholder={t("crawl.links.placeholders.timeout")}
            disabled={linkPreviewDisabled}
          />
        </Form.Item>
        <Form.Item label={t("crawl.links.contextQuery")} name={["linkPreview", "query"]}>
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
      <Form.List name="multiUrlConfigs">
        {(fields, { add, remove }) => (
          <Space direction="vertical" style={{ width: "100%" }} size="large">
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <Typography.Text strong>{t("crawl.multiUrl.title")}</Typography.Text>
              <Button
                type="dashed"
                icon={<PlusOutlined />}
                onClick={() => add()}
                size="small"
              >
                {t("crawl.multiUrl.add")}
              </Button>
            </div>
            {fields.length === 0 ? (
              <Typography.Text type="secondary">
                {t("crawl.multiUrl.empty")}
              </Typography.Text>
            ) : null}
            {fields.map((field, index) => (
              <Card
                key={field.key}
                size="small"
                title={t("crawl.multiUrl.strategyTitle", { index: index + 1 })}
                extra={
                  <Button
                    type="link"
                    danger
                    icon={<MinusCircleOutlined />}
                    onClick={() => remove(field.name)}
                  >
                    {t("common.remove")}
                  </Button>
                }
              >
                <Form.Item label={t("crawl.multiUrl.fields.label")} name={[field.name, "name"]}>
                  <Input placeholder={t("crawl.multiUrl.placeholders.label")} />
                </Form.Item>
                <Form.Item
                  label={t("crawl.multiUrl.fields.matchMode")}
                  name={[field.name, "matcher", "matchMode"]}
                  extra={t("crawl.multiUrl.matchModeHint")}
                >
                  <Select
                    allowClear
                    placeholder={t("crawl.multiUrl.placeholders.matchMode")}
                    options={[
                      { value: "glob", label: t("crawl.multiUrl.matchModeOptions.glob") },
                      { value: "regex", label: t("crawl.multiUrl.matchModeOptions.regex") },
                      { value: "substring", label: t("crawl.multiUrl.matchModeOptions.substring") },
                      { value: "prefix", label: t("crawl.multiUrl.matchModeOptions.prefix") },
                    ]}
                  />
                </Form.Item>
                <Form.Item
                  label={t("crawl.multiUrl.fields.patterns")}
                  name={[field.name, "matcher", "patterns"]}
                  rules={[
                    {
                      validator: (_, value) => {
                        if (!value || value.length === 0) {
                          return Promise.resolve();
                        }
                        return Promise.resolve();
                      },
                    },
                  ]}
                >
                  <Select
                    mode="tags"
                    tokenSeparators={[",", " "]}
                    placeholder={t("crawl.multiUrl.placeholders.patterns")}
                    style={{ width: "100%" }}
                  />
                </Form.Item>
                <Form.Item
                  label={t("crawl.multiUrl.fields.urls")}
                  name={[field.name, "urls"]}
                  extra={t("crawl.multiUrl.urlsHint")}
                >
                  <Select
                    mode="tags"
                    tokenSeparators={[",", " "]}
                    placeholder={t("crawl.multiUrl.placeholders.urls")}
                    style={{ width: "100%" }}
                  />
                </Form.Item>
                <Form.Item
                  label={t("crawl.multiUrl.fields.cacheMode")}
                  name={[field.name, "options", "cacheMode"]}
                >
                  <Select
                    allowClear
                    placeholder={t("crawl.multiUrl.placeholders.cacheMode")}
                    options={[
                      { value: "bypass", label: t("crawl.multiUrl.cacheModes.bypass") },
                      { value: "prefer_cache", label: t("crawl.multiUrl.cacheModes.prefer") },
                      { value: "force_cache", label: t("crawl.multiUrl.cacheModes.force") },
                    ]}
                  />
                </Form.Item>
                <Form.Item
                  label={t("crawl.settings.scanFullPage")}
                  name={[field.name, "options", "scanFullPage"]}
                  valuePropName="checked"
                >
                  <Switch />
                </Form.Item>
                <Form.Item
                  label={t("crawl.settings.scrollDelay")}
                  name={[field.name, "options", "scrollDelayMs"]}
                >
                  <InputNumber
                    min={0}
                    max={5000}
                    style={{ width: "100%" }}
                    placeholder={t("crawl.settings.placeholders.scrollDelay")}
                  />
                </Form.Item>
                <Typography.Text strong style={{ marginBottom: 8, display: "block" }}>
                  {t("crawl.virtualScroll.title")}
                </Typography.Text>
                <Form.Item
                  label={t("crawl.virtualScroll.enable")}
                  name={[field.name, "options", "virtualScroll", "enabled"]}
                  valuePropName="checked"
                >
	                  <Switch
	                    onChange={(enabled) => {
	                      const basePath = ["multiUrlConfigs", field.name, "options", "virtualScroll"] as (string | number)[];
	                      if (!enabled) {
	                        form.setFields([{ name: basePath as any, value: undefined }]);
	                        return;
	                      }
	                      const current = (form.getFieldValue(basePath as any) ?? {}) as Record<string, unknown>;
                      const containerSelector =
                        typeof current.containerSelector === "string" &&
                        current.containerSelector.trim().length
                          ? current.containerSelector
                          : "body";
                      const scrollCount =
                        typeof current.scrollCount === "number" && Number.isFinite(current.scrollCount)
                          ? current.scrollCount
                          : 10;
                      const scrollBy =
                        typeof current.scrollBy === "string" && current.scrollBy.length
                          ? current.scrollBy
                          : "page_height";
                      const scrollByPixels =
                        typeof current.scrollByPixels === "number" && Number.isFinite(current.scrollByPixels)
                          ? current.scrollByPixels
                          : 500;
                      const waitAfterScrollMs =
                        typeof current.waitAfterScrollMs === "number" &&
                        Number.isFinite(current.waitAfterScrollMs)
                          ? current.waitAfterScrollMs
                          : 600;
	                      form.setFields([
	                        { name: ["multiUrlConfigs", field.name, "options", "scanFullPage"], value: false },
	                        { name: ["multiUrlConfigs", field.name, "options", "scrollDelayMs"], value: undefined },
	                        { name: [...basePath, "enabled"] as any, value: true },
	                        { name: [...basePath, "containerSelector"] as any, value: containerSelector },
	                        { name: [...basePath, "scrollCount"] as any, value: scrollCount },
	                        { name: [...basePath, "scrollBy"] as any, value: scrollBy },
	                        { name: [...basePath, "scrollByPixels"] as any, value: scrollByPixels },
	                        { name: [...basePath, "waitAfterScrollMs"] as any, value: waitAfterScrollMs }
	                      ]);
	                    }}
	                  />
                </Form.Item>
                <Form.Item
                  noStyle
                  shouldUpdate={(prev, next) => {
                    const prevEnabled = prev?.multiUrlConfigs?.[field.name]?.options?.virtualScroll?.enabled;
                    const nextEnabled = next?.multiUrlConfigs?.[field.name]?.options?.virtualScroll?.enabled;
                    return prevEnabled !== nextEnabled;
                  }}
                >
                  {() => {
                    const enabled = Boolean(
                      form.getFieldValue([
                        "multiUrlConfigs",
                        field.name,
                        "options",
                        "virtualScroll",
                        "enabled"
                      ])
                    );
                    if (!enabled) {
                      return null;
                    }
                    return (
                      <>
                        <Form.Item
                          label={t("crawl.virtualScroll.containerSelector")}
                          name={[field.name, "options", "virtualScroll", "containerSelector"]}
                          extra={t("crawl.virtualScroll.containerSelectorHint")}
                        >
                          <Input placeholder="body" />
                        </Form.Item>
                        <Form.Item
                          label={t("crawl.virtualScroll.scrollCount")}
                          name={[field.name, "options", "virtualScroll", "scrollCount"]}
                          extra={t("crawl.virtualScroll.scrollCountHint")}
                        >
                          <InputNumber min={1} max={1000} style={{ width: "100%" }} />
                        </Form.Item>
                        <Form.Item
                          label={t("crawl.virtualScroll.scrollBy")}
                          name={[field.name, "options", "virtualScroll", "scrollBy"]}
                          extra={t("crawl.virtualScroll.scrollByHint")}
                        >
                          <Select
                            allowClear
                            options={[
                              { value: "page_height", label: t("crawl.virtualScroll.scrollByOptions.pageHeight") },
                              { value: "container_height", label: t("crawl.virtualScroll.scrollByOptions.containerHeight") },
                              { value: "pixels", label: t("crawl.virtualScroll.scrollByOptions.pixels") }
                            ]}
                          />
                        </Form.Item>
                        <Form.Item
                          noStyle
                          shouldUpdate={(prev, next) => {
                            const prevValue =
                              prev?.multiUrlConfigs?.[field.name]?.options?.virtualScroll?.scrollBy;
                            const nextValue =
                              next?.multiUrlConfigs?.[field.name]?.options?.virtualScroll?.scrollBy;
                            return prevValue !== nextValue;
                          }}
                        >
                          {() => {
                            const scrollBy = form.getFieldValue([
                              "multiUrlConfigs",
                              field.name,
                              "options",
                              "virtualScroll",
                              "scrollBy",
                            ]);
                            if (scrollBy !== "pixels") {
                              return null;
                            }
                            return (
                              <Form.Item
                                label={t("crawl.virtualScroll.scrollByPixels")}
                                name={[field.name, "options", "virtualScroll", "scrollByPixels"]}
                                extra={t("crawl.virtualScroll.scrollByPixelsHint")}
                              >
                                <InputNumber min={1} max={20000} step={50} style={{ width: "100%" }} />
                              </Form.Item>
                            );
                          }}
                        </Form.Item>
                        <Form.Item
                          label={t("crawl.virtualScroll.waitAfterScroll")}
                          name={[field.name, "options", "virtualScroll", "waitAfterScrollMs"]}
                          extra={t("crawl.virtualScroll.waitAfterScrollHint")}
                        >
                          <InputNumber min={0} max={60000} step={100} style={{ width: "100%" }} />
                        </Form.Item>
                      </>
                    );
                  }}
                </Form.Item>
                <Form.Item
                  label={t("crawl.settings.adjustViewport")}
                  name={[field.name, "options", "adjustViewportToContent"]}
                  valuePropName="checked"
                >
                  <Switch />
                </Form.Item>
                <Form.Item
                  label={t("crawl.settings.onlyMainContent")}
                  name={[field.name, "options", "onlyMainContent"]}
                  valuePropName="checked"
                >
                  <Switch />
                </Form.Item>
                <Form.Item
                  label={t("crawl.settings.extractLinks")}
                  name={[field.name, "options", "extractLinks"]}
                  valuePropName="checked"
                >
                  <Switch />
                </Form.Item>
                <Form.Item
                  label={t("crawl.settings.simulateUser")}
                  name={[field.name, "options", "simulateUser"]}
                  valuePropName="checked"
                >
                  <Switch />
                </Form.Item>
                <Form.Item
                  label={t("crawl.settings.overrideNavigator")}
                  name={[field.name, "options", "overrideNavigator"]}
                  valuePropName="checked"
                >
                  <Switch />
                </Form.Item>
                <Typography.Text
                  strong
                  style={{ marginBottom: 8, display: "block" }}
                >
                  {t("crawl.multiUrl.dynamicOverrides")}
                </Typography.Text>
                <Form.List name={[field.name, "options", "jsCode"]}>
                  {(jsFields, { add: addJs, remove: removeJs }) => (
                    <Space direction="vertical" style={{ width: "100%" }}>
                      {jsFields.map((jsField, jsIndex) => (
                        <Space key={jsField.key} align="start">
                          <Form.Item
                            {...jsField}
                            label={t("crawl.dynamic.jsStep", { index: jsIndex + 1 })}
                            style={{ flex: 1 }}
                          >
                            <Input.TextArea
                              rows={2}
                              placeholder={t("crawl.dynamic.placeholders.jsSnippet")}
                            />
                          </Form.Item>
                          <Button
                            type="link"
                            danger
                            icon={<MinusCircleOutlined />}
                            onClick={() => removeJs(jsField.name)}
                          />
                        </Space>
                      ))}
                      <Button
                        type="dashed"
                        icon={<PlusOutlined />}
                        onClick={() => addJs()}
                      >
                        {t("crawl.dynamic.addJsStep")}
                      </Button>
                    </Space>
                  )}
                </Form.List>
                <Form.Item
                  label={t("crawl.dynamic.jsOnly")}
                  name={[field.name, "options", "jsOnly"]}
                  valuePropName="checked"
                >
                  <Switch />
                </Form.Item>
                <Form.Item
                  label={t("crawl.dynamic.waitForSelector")}
                  name={[field.name, "options", "waitForSelector"]}
                >
                  <Input placeholder={t("crawl.dynamic.placeholders.selectorAlt")} />
                </Form.Item>
                <Form.Item
                  label={t("crawl.dynamic.waitForScript")}
                  name={[field.name, "options", "waitForScript"]}
                >
                  <Input.TextArea
                    rows={2}
                    placeholder={t("crawl.dynamic.placeholders.scriptAlt")}
                  />
                </Form.Item>
                <Form.Item
                  label={t("crawl.dynamic.waitTimeout")}
                  name={[field.name, "options", "waitForTimeoutMs"]}
                >
                  <InputNumber
                    min={500}
                    max={60000}
                    style={{ width: "100%" }}
                    placeholder={t("crawl.dynamic.placeholders.waitTimeout")}
                  />
                </Form.Item>
              </Card>
            ))}
          </Space>
        )}
      </Form.List>
    </>
  );
}

interface BrowserConfigFormProps {
  userAgentModeValue?: string;
  useManagedBrowserValue?: boolean;
  proxyUrlActive: boolean;
  proxyObjectActive: boolean;
}

function BrowserConfigForm({
  userAgentModeValue,
  useManagedBrowserValue,
  proxyUrlActive,
  proxyObjectActive,
}: BrowserConfigFormProps) {
  const { t } = useTranslation();
  return (
    <>
      <Form.Item
        label={t("crawl.browser.headless", { defaultValue: "Headless" })}
        name="headless"
        valuePropName="checked"
        extra={t("crawl.browser.headlessHint", {
          defaultValue:
            "Turn off to use headed mode (headless=false). Headed mode may require Xvfb/DISPLAY inside the crawl4ai container."
        })}
      >
        <Switch defaultChecked />
      </Form.Item>
      <Form.Item
        label={t("crawl.browser.undetected")}
        name="enableUndetectedBrowser"
        valuePropName="checked"
        extra={t("crawl.browser.undetectedHint")}
      >
        <Switch />
      </Form.Item>
      <Form.Item
        label={t("crawl.browser.stealth")}
        name="enableStealthMode"
        valuePropName="checked"
        extra={t("crawl.browser.stealthHint")}
      >
        <Switch />
      </Form.Item>
      <Form.Item
        label={t("crawl.browser.managed")}
        name="useManagedBrowser"
        valuePropName="checked"
        extra={
          <span>
            {t("crawl.browser.managedHint")}{" "}
            <Typography.Link
              href="https://github.com/unclecode/crawl4ai/blob/main/docs/md_v2/advanced/identity-based-crawling.md"
              target="_blank"
              rel="noreferrer"
              style={{ marginLeft: 4 }}
            >
              {t("crawl.browser.managedLink")}
            </Typography.Link>
            {t("common.punctuation.period")}
          </span>
        }
      >
        <Switch />
      </Form.Item>
      <Form.Item
        label={t("crawl.browser.userDataDir")}
        name="userDataDir"
        extra={t("crawl.browser.userDataDirHint")}
      >
        <Input
          placeholder={t("crawl.browser.placeholders.userDataDir")}
          disabled={!useManagedBrowserValue}
        />
      </Form.Item>
      <Card
        title={t("crawl.browser.identity.title")}
        size="small"
        style={{ marginBottom: 16 }}
        extra={
          <Typography.Link
            href="https://github.com/unclecode/crawl4ai/blob/main/docs/md_v2/core/browser-crawler-config.md"
            target="_blank"
            rel="noreferrer"
          >
            {t("common.docs")}
          </Typography.Link>
        }
      >
        <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
          {t("crawl.browser.identity.description")}
        </Typography.Paragraph>
        <Form.Item
          label={t("crawl.browser.identity.customUserAgent")}
          name="userAgent"
          extra={t("crawl.browser.identity.customUserAgentHint")}
        >
          <Input placeholder={t("crawl.browser.identity.placeholders.userAgent")} maxLength={768} />
        </Form.Item>
        <Form.Item
          label={t("crawl.browser.identity.userAgentMode")}
          name="userAgentMode"
          extra={t("crawl.browser.identity.userAgentModeHint")}
        >
          <Select
            allowClear
            placeholder={t("crawl.browser.identity.placeholders.userAgentMode")}
            options={[{ value: "random", label: t("crawl.browser.identity.userAgentModeRandom") }]}
          />
        </Form.Item>
        <Form.Item
          label={t("crawl.browser.identity.generatorPlatform")}
          name={["userAgentGenerator", "platform"]}
        >
          <Select
            allowClear
            placeholder={t("crawl.browser.identity.placeholders.platform")}
            disabled={userAgentModeValue !== "random"}
            options={[
              { value: "windows", label: t("crawl.browser.identity.platforms.windows") },
              { value: "macos", label: t("crawl.browser.identity.platforms.macos") },
              { value: "linux", label: t("crawl.browser.identity.platforms.linux") },
              { value: "android", label: t("crawl.browser.identity.platforms.android") },
              { value: "ios", label: t("crawl.browser.identity.platforms.ios") },
            ]}
          />
        </Form.Item>
        <Form.Item
          label={t("crawl.browser.identity.generatorBrowser")}
          name={["userAgentGenerator", "browser"]}
        >
          <Select
            allowClear
            placeholder={t("crawl.browser.identity.placeholders.browser")}
            disabled={userAgentModeValue !== "random"}
            options={[
              { value: "chrome", label: t("crawl.browser.identity.browsers.chrome") },
              { value: "firefox", label: t("crawl.browser.identity.browsers.firefox") },
              { value: "safari", label: t("crawl.browser.identity.browsers.safari") },
              { value: "edge", label: t("crawl.browser.identity.browsers.edge") },
            ]}
          />
        </Form.Item>
        <Form.Item
          label={t("crawl.browser.identity.generatorDevice")}
          name={["userAgentGenerator", "deviceType"]}
        >
          <Select
            allowClear
            placeholder={t("crawl.browser.identity.placeholders.device")}
            disabled={userAgentModeValue !== "random"}
            options={[
              { value: "desktop", label: t("crawl.browser.identity.devices.desktop") },
              { value: "mobile", label: t("crawl.browser.identity.devices.mobile") },
              { value: "tablet", label: t("crawl.browser.identity.devices.tablet") },
            ]}
          />
        </Form.Item>
        <Form.Item
          label={t("crawl.browser.identity.generatorLocale")}
          name={["userAgentGenerator", "locale"]}
          extra={t("crawl.browser.identity.generatorLocaleHint")}
        >
          <Input
            placeholder={t("crawl.browser.identity.placeholders.locale")}
            maxLength={16}
            disabled={userAgentModeValue !== "random"}
          />
        </Form.Item>
        <Form.Item
          label={t("crawl.browser.identity.browserLocale")}
          name="locale"
          extra={t("crawl.browser.identity.browserLocaleHint")}
        >
          <Input placeholder={t("crawl.browser.identity.placeholders.locale")} maxLength={16} />
        </Form.Item>
        <Form.Item
          label={t("crawl.browser.identity.timezoneId")}
          name="timezoneId"
          extra={t("crawl.browser.identity.timezoneHint")}
        >
          <Input placeholder={t("crawl.browser.identity.placeholders.timezone")} maxLength={64} />
        </Form.Item>
        <Form.Item
          label={t("crawl.browser.identity.geolocation")}
          extra={t("crawl.browser.identity.geolocationHint")}
        >
          <Space wrap>
            <Form.Item name={["geolocation", "latitude"]} noStyle>
              <InputNumber
                placeholder={t("crawl.browser.identity.placeholders.latitude")}
                min={-90}
                max={90}
                step={0.1}
                style={{ width: 140 }}
              />
            </Form.Item>
            <Form.Item name={["geolocation", "longitude"]} noStyle>
              <InputNumber
                placeholder={t("crawl.browser.identity.placeholders.longitude")}
                min={-180}
                max={180}
                step={0.1}
                style={{ width: 140 }}
              />
            </Form.Item>
            <Form.Item name={["geolocation", "accuracy"]} noStyle>
              <InputNumber
                placeholder={t("crawl.browser.identity.placeholders.accuracy")}
                min={1}
                max={5000}
                step={1}
                style={{ width: 140 }}
              />
            </Form.Item>
          </Space>
        </Form.Item>
        <Typography.Title level={5} style={{ marginTop: 16 }}>
          {t("crawl.browser.headers.title")}
        </Typography.Title>
        <Form.List name="browserHeaders">
          {(fields, { add, remove }) => (
            <Space direction="vertical" style={{ width: "100%" }}>
              {fields.map((field) => (
                <Space
                  key={field.key}
                  align="baseline"
                  style={{ width: "100%" }}
                >
                  <Form.Item name={[field.name, "name"]} style={{ flex: 1 }}>
                    <Input placeholder={t("crawl.browser.headers.placeholders.name")} />
                  </Form.Item>
                  <Form.Item name={[field.name, "value"]} style={{ flex: 2 }}>
                    <Input placeholder={t("crawl.browser.headers.placeholders.value")} />
                  </Form.Item>
                  <Button
                    type="text"
                    icon={<MinusCircleOutlined />}
                    danger
                    onClick={() => remove(field.name)}
                  />
                </Space>
              ))}
              <Button
                type="dashed"
                onClick={() => add()}
                icon={<PlusOutlined />}
                block
              >
                {t("crawl.browser.headers.add")}
              </Button>
            </Space>
          )}
        </Form.List>
        <Typography.Title level={5} style={{ marginTop: 24 }}>
          {t("crawl.browser.cookies.title")}
        </Typography.Title>
        <Form.List name="browserCookies">
          {(fields, { add, remove }) => (
            <Space direction="vertical" style={{ width: "100%" }}>
              {fields.map((field) => (
                <Space
                  key={field.key}
                  align="baseline"
                  style={{ width: "100%" }}
                >
                  <Form.Item name={[field.name, "name"]} style={{ flex: 1 }}>
                    <Input placeholder={t("crawl.browser.cookies.placeholders.name")} />
                  </Form.Item>
                  <Form.Item name={[field.name, "value"]} style={{ flex: 2 }}>
                    <Input placeholder={t("crawl.browser.cookies.placeholders.value")} />
                  </Form.Item>
                  <Form.Item
                    name={[field.name, "domain"]}
                    style={{ flex: 1.3 }}
                  >
                    <Input placeholder={t("crawl.browser.cookies.placeholders.domain")} />
                  </Form.Item>
                  <Form.Item name={[field.name, "path"]} style={{ flex: 1 }}>
                    <Input placeholder={t("crawl.browser.cookies.placeholders.path")} />
                  </Form.Item>
                  <Button
                    type="text"
                    icon={<MinusCircleOutlined />}
                    danger
                    onClick={() => remove(field.name)}
                  />
                </Space>
              ))}
              <Button
                type="dashed"
                onClick={() => add()}
                icon={<PlusOutlined />}
                block
              >
                {t("crawl.browser.cookies.add")}
              </Button>
            </Space>
          )}
        </Form.List>
      </Card>
      <Card
        title={t("crawl.session.title")}
        size="small"
        style={{ marginBottom: 16 }}
        extra={
          <Typography.Link
            href="https://github.com/unclecode/crawl4ai/blob/main/docs/md_v2/advanced/session-management.md"
            target="_blank"
            rel="noreferrer"
          >
            {t("common.docs")}
          </Typography.Link>
        }
      >
        <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
          {t("crawl.session.description")}
        </Typography.Paragraph>
        <Form.Item
          label={t("crawl.session.sessionId")}
          name="sessionId"
          extra={t("crawl.session.sessionIdHint")}
        >
          <Input placeholder={t("crawl.session.placeholders.sessionId")} maxLength={160} />
        </Form.Item>
        <Form.Item
          label={t("crawl.session.storageState")}
          name="storageState"
          extra={t("crawl.session.storageStateHint")}
        >
          <Input.TextArea
            rows={4}
            placeholder={t("crawl.session.placeholders.storageState")}
            maxLength={12000}
          />
        </Form.Item>
      </Card>
      <Card title={t("crawl.proxy.title")} size="small" style={{ marginBottom: 16 }}>
        <Form.Item
          label={t("crawl.proxy.url")}
          name="proxyUrl"
          extra={t("crawl.proxy.urlHint")}
        >
          <Input
            placeholder={t("crawl.proxy.placeholders.url")}
            disabled={proxyObjectActive}
          />
        </Form.Item>
        <Form.Item
          label={t("crawl.proxy.server")}
          name={["proxyConfig", "server"]}
          extra={t("crawl.proxy.serverHint")}
        >
          <Input
            placeholder={t("crawl.proxy.placeholders.server")}
            disabled={proxyUrlActive}
          />
        </Form.Item>
        <Form.Item label={t("crawl.proxy.username")} name={["proxyConfig", "username"]}>
          <Input placeholder={t("crawl.proxy.placeholders.username")} disabled={proxyUrlActive} />
        </Form.Item>
        <Form.Item label={t("crawl.proxy.password")} name={["proxyConfig", "password"]}>
          <Input.Password
            placeholder={t("crawl.proxy.placeholders.password")}
            disabled={proxyUrlActive}
          />
        </Form.Item>
      </Card>
    </>
  );
}
