"use client";

/**
 * Create Crawl Task 抽屉的根级通用抓取设置（FE-批5B：自 CreateCrawlTaskDrawer.tsx 拆出）。
 * ingest 门禁（canWriteItems）、关键词/时间范围/并发、内容开关组、
 * scanFullPage/scrollDelay（受根级 virtualScroll 联动禁用）。
 */

import { DatePicker, Form, InputNumber, Select, Switch } from "antd";
import { useTranslation } from "react-i18next";

import dayjs from "@/lib/dayjs";

import type { CreateCrawlTaskFormValues } from "../../types";

export interface GeneralCrawlFieldsProps {
  canWriteItems: boolean;
}

export function GeneralCrawlFields({ canWriteItems }: GeneralCrawlFieldsProps) {
  const { t } = useTranslation();
  const form = Form.useFormInstance<CreateCrawlTaskFormValues>();
  const virtualScrollEnabled = Boolean(
    Form.useWatch(["virtualScroll", "enabled"], form),
  );
  const scanFullPage = Form.useWatch("scanFullPage", form);
  const ingestHint = canWriteItems
    ? t("crawl.settings.ingestToItemsHint")
    : t("crawl.settings.ingestToItemsNoPermission");

  return (
    <>
      <Form.Item
        label={t("crawl.settings.ingestToItems")}
        name="ingestToItems"
        valuePropName="checked"
        extra={ingestHint}
      >
        <Switch disabled={!canWriteItems} />
      </Form.Item>
      <Form.Item label={t("crawl.settings.keywords")} name="keywords">
        <Select
          mode="tags"
          placeholder={t("crawl.settings.placeholders.keywords")}
        />
      </Form.Item>
      <Form.Item label={t("crawl.settings.timeRange")} name="timeRange">
        <DatePicker.RangePicker
          allowClear
          showTime
          style={{ width: "100%" }}
          disabledDate={(date) => date && date > dayjs()}
        />
      </Form.Item>
      <Form.Item
        label={t("crawl.settings.concurrency")}
        name="concurrency"
        extra={t("crawl.settings.concurrencyHint")}
      >
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
        extra={t("crawl.settings.scanFullPageHint")}
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
    </>
  );
}
