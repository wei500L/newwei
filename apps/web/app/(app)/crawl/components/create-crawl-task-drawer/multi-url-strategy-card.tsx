"use client";

/**
 * Create Crawl Task 抽屉的 multi URL 策略卡（FE-批5B：自 CreateCrawlTaskDrawer.tsx 拆出）。
 * 卡壳（标题带真实 index、Remove）、名称/匹配器/URLs、策略 options
 * 基础项；详情展开、嵌套 virtual scroll 与动态覆盖由各自领域组件渲染。
 */

import { MinusCircleOutlined } from "@ant-design/icons";
import type { FormListFieldData } from "antd";
import {
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Select,
  Switch,
} from "antd";
import { useTranslation } from "react-i18next";

import { MultiUrlOverridesFields } from "./multi-url-overrides-fields";
import { MultiUrlStrategyDetails } from "./multi-url-strategy-details";
import { MultiUrlVirtualScrollFields } from "./multi-url-virtual-scroll";

export interface MultiUrlStrategyCardProps {
  field: FormListFieldData;
  index: number;
  onRemove: () => void;
}

export function MultiUrlStrategyCard({
  field,
  index,
  onRemove,
}: MultiUrlStrategyCardProps) {
  const { t } = useTranslation();
  return (
    <Card
      size="small"
      title={t("crawl.multiUrl.strategyTitle", { index: index + 1 })}
      extra={
        <Button
          type="link"
          danger
          icon={<MinusCircleOutlined />}
          onClick={onRemove}
        >
          {t("common.remove")}
        </Button>
      }
    >
      <Form.Item
        label={t("crawl.multiUrl.fields.label")}
        name={[field.name, "name"]}
      >
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
            {
              value: "glob",
              label: t("crawl.multiUrl.matchModeOptions.glob"),
            },
            {
              value: "regex",
              label: t("crawl.multiUrl.matchModeOptions.regex"),
            },
            {
              value: "substring",
              label: t("crawl.multiUrl.matchModeOptions.substring"),
            },
            {
              value: "prefix",
              label: t("crawl.multiUrl.matchModeOptions.prefix"),
            },
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
            {
              value: "bypass",
              label: t("crawl.multiUrl.cacheModes.bypass"),
            },
            {
              value: "prefer_cache",
              label: t("crawl.multiUrl.cacheModes.prefer"),
            },
            {
              value: "force_cache",
              label: t("crawl.multiUrl.cacheModes.force"),
            },
          ]}
        />
      </Form.Item>
      <Form.Item
        label={t("crawl.settings.qualityProfile")}
        name={[field.name, "options", "qualityProfile"]}
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
        name={[field.name, "options", "pageTypeHint"]}
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
      <MultiUrlStrategyDetails field={field} />
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
      <MultiUrlVirtualScrollFields field={field} />
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
      <MultiUrlOverridesFields field={field} />
    </Card>
  );
}
