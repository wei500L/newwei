"use client";

/**
 * Create Crawl Task 抽屉的 virtual scroll 领域（FE-批5B：自 CreateCrawlTaskDrawer.tsx 拆出）。
 *
 * 根级卡（VirtualScrollFields）持有 enable/scrollBy watch；
 * VirtualScrollConfigItems 与 toggleVirtualScroll/readVirtualScrollDefaults
 * 为根级与 multiUrl 嵌套共享的字段组与开关联动——共享字段语义，
 * 但路径前缀由调用方给定（根级 ["virtualScroll"]，嵌套
 * ["multiUrlConfigs", n, "options", "virtualScroll"]），不共享错误 path。
 */

import type { FormInstance } from "antd";
import {
  Card,
  Form,
  Input,
  InputNumber,
  Select,
  Switch,
  Typography,
} from "antd";
import { useTranslation } from "react-i18next";

import type { CreateCrawlTaskFormValues } from "../../types";

import type { MultiUrlVirtualScrollPath } from "./field-paths";

/** virtualScroll 字段组可用的路径前缀（根级或 multi URL 嵌套）。 */
export type VirtualScrollBasePath =
  | ["virtualScroll"]
  | MultiUrlVirtualScrollPath;

export function VirtualScrollLeadingItems({
  basePath,
}: {
  basePath: VirtualScrollBasePath;
}) {
  const { t } = useTranslation();
  return (
    <>
      <Form.Item
        label={t("crawl.virtualScroll.containerSelector")}
        name={[...basePath, "containerSelector"]}
        extra={t("crawl.virtualScroll.containerSelectorHint")}
      >
        <Input placeholder="body" />
      </Form.Item>
      <Form.Item
        label={t("crawl.virtualScroll.scrollCount")}
        name={[...basePath, "scrollCount"]}
        extra={t("crawl.virtualScroll.scrollCountHint")}
      >
        <InputNumber min={1} max={1000} style={{ width: "100%" }} />
      </Form.Item>
      <Form.Item
        label={t("crawl.virtualScroll.scrollBy")}
        name={[...basePath, "scrollBy"]}
        extra={t("crawl.virtualScroll.scrollByHint")}
      >
        <Select
          allowClear
          options={[
            {
              value: "page_height",
              label: t("crawl.virtualScroll.scrollByOptions.pageHeight"),
            },
            {
              value: "container_height",
              label: t("crawl.virtualScroll.scrollByOptions.containerHeight"),
            },
            {
              value: "pixels",
              label: t("crawl.virtualScroll.scrollByOptions.pixels"),
            },
          ]}
        />
      </Form.Item>
    </>
  );
}

export function VirtualScrollPixelsItem({
  basePath,
}: {
  basePath: VirtualScrollBasePath;
}) {
  const { t } = useTranslation();
  return (
    <Form.Item
      label={t("crawl.virtualScroll.scrollByPixels")}
      name={[...basePath, "scrollByPixels"]}
      extra={t("crawl.virtualScroll.scrollByPixelsHint")}
    >
      <InputNumber
        min={1}
        max={20000}
        step={50}
        style={{ width: "100%" }}
      />
    </Form.Item>
  );
}

export function VirtualScrollTrailingItems({
  basePath,
}: {
  basePath: VirtualScrollBasePath;
}) {
  const { t } = useTranslation();
  return (
    <Form.Item
      label={t("crawl.virtualScroll.waitAfterScroll")}
      name={[...basePath, "waitAfterScrollMs"]}
      extra={t("crawl.virtualScroll.waitAfterScrollHint")}
    >
      <InputNumber
        min={0}
        max={60000}
        step={100}
        style={{ width: "100%" }}
      />
    </Form.Item>
  );
}

export interface VirtualScrollConfigItemsProps {
  basePath: VirtualScrollBasePath;
  /** scrollBy=pixels 时显示 scrollByPixels 字段。 */
  showPixels: boolean;
}

function VirtualScrollConfigItems({
  basePath,
  showPixels,
}: VirtualScrollConfigItemsProps) {
  return (
    <>
      <VirtualScrollLeadingItems basePath={basePath} />
      {showPixels ? <VirtualScrollPixelsItem basePath={basePath} /> : null}
      <VirtualScrollTrailingItems basePath={basePath} />
    </>
  );
}

interface VirtualScrollDefaults {
  containerSelector: string;
  scrollCount: number;
  scrollBy: string;
  scrollByPixels: number;
  waitAfterScrollMs: number;
}

const readVirtualScrollDefaults = (
  current: Record<string, unknown>,
): VirtualScrollDefaults => ({
  containerSelector:
    typeof current.containerSelector === "string" &&
    current.containerSelector.trim().length
      ? current.containerSelector
      : "body",
  scrollCount:
    typeof current.scrollCount === "number" &&
    Number.isFinite(current.scrollCount)
      ? current.scrollCount
      : 10,
  scrollBy:
    typeof current.scrollBy === "string" && current.scrollBy.length
      ? current.scrollBy
      : "page_height",
  scrollByPixels:
    typeof current.scrollByPixels === "number" &&
    Number.isFinite(current.scrollByPixels)
      ? current.scrollByPixels
      : 500,
  waitAfterScrollMs:
    typeof current.waitAfterScrollMs === "number" &&
    Number.isFinite(current.waitAfterScrollMs)
      ? current.waitAfterScrollMs
      : 600,
});

/** 开启时补默认值并关闭同级 scanFullPage/scrollDelay；关闭时整体清除。 */
export function toggleVirtualScroll(
  form: FormInstance<CreateCrawlTaskFormValues>,
  paths: {
    virtualScroll: VirtualScrollBasePath;
    scanFullPage: ["scanFullPage"] | ["multiUrlConfigs", number, "options", "scanFullPage"];
    scrollDelayMs: ["scrollDelayMs"] | ["multiUrlConfigs", number, "options", "scrollDelayMs"];
  },
  enabled: boolean,
): void {
  if (!enabled) {
    form.setFields([{ name: paths.virtualScroll, value: undefined }]);
    return;
  }
  const current = (form.getFieldValue(paths.virtualScroll) ??
    {}) as Record<string, unknown>;
  const defaults = readVirtualScrollDefaults(current);
  form.setFields([
    {
      name: paths.scanFullPage,
      value: false,
    },
    {
      name: paths.scrollDelayMs,
      value: undefined,
    },
    { name: [...paths.virtualScroll, "enabled"], value: true },
    {
      name: [...paths.virtualScroll, "containerSelector"],
      value: defaults.containerSelector,
    },
    { name: [...paths.virtualScroll, "scrollCount"], value: defaults.scrollCount },
    { name: [...paths.virtualScroll, "scrollBy"], value: defaults.scrollBy },
    {
      name: [...paths.virtualScroll, "scrollByPixels"],
      value: defaults.scrollByPixels,
    },
    {
      name: [...paths.virtualScroll, "waitAfterScrollMs"],
      value: defaults.waitAfterScrollMs,
    },
  ]);
}

export function VirtualScrollFields() {
  const { t } = useTranslation();
  const form = Form.useFormInstance<CreateCrawlTaskFormValues>();
  const virtualScrollEnabled = Boolean(
    Form.useWatch(["virtualScroll", "enabled"], form),
  );
  const virtualScrollScrollByValue = Form.useWatch(
    ["virtualScroll", "scrollBy"],
    form,
  );
  const scanFullPage = Form.useWatch("scanFullPage", form);

  return (
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
          onChange={(enabled) =>
            toggleVirtualScroll(
              form,
              {
                virtualScroll: ["virtualScroll"],
                scanFullPage: ["scanFullPage"],
                scrollDelayMs: ["scrollDelayMs"],
              },
              enabled,
            )
          }
        />
      </Form.Item>
      {virtualScrollEnabled ? (
        <>
          <VirtualScrollConfigItems
            basePath={["virtualScroll"]}
            showPixels={virtualScrollScrollByValue === "pixels"}
          />
          {scanFullPage ? (
            <Typography.Text type="secondary" style={{ display: "block" }}>
              {t("crawl.virtualScroll.scanFullPageHint")}
            </Typography.Text>
          ) : null}
        </>
      ) : null}
    </Card>
  );
}
