"use client";

/**
 * Create Crawl Task 抽屉的浏览器身份卡（FE-批5B：自 CreateCrawlTaskDrawer.tsx 拆出）。
 * 自定义 UA、UA 模式与 generator 联动（仅 random 模式可用）、locale/
 * timezone、geolocation 三段输入；headers/cookies 列表渲染在本卡内尾部。
 */

import { Card, Form, Input, InputNumber, Select, Space, Typography } from "antd";
import { useTranslation } from "react-i18next";

import type { CreateCrawlTaskFormValues } from "../../types";

import { BrowserHeadersCookiesFields } from "./browser-headers-cookies-fields";

export function BrowserIdentityFields() {
  const { t } = useTranslation();
  const form = Form.useFormInstance<CreateCrawlTaskFormValues>();
  const userAgentModeValue = Form.useWatch("userAgentMode", form);

  return (
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
        <Input
          placeholder={t("crawl.browser.identity.placeholders.userAgent")}
          maxLength={768}
        />
      </Form.Item>
      <Form.Item
        label={t("crawl.browser.identity.userAgentMode")}
        name="userAgentMode"
        extra={t("crawl.browser.identity.userAgentModeHint")}
      >
        <Select
          allowClear
          placeholder={t("crawl.browser.identity.placeholders.userAgentMode")}
          options={[
            {
              value: "random",
              label: t("crawl.browser.identity.userAgentModeRandom"),
            },
          ]}
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
            {
              value: "windows",
              label: t("crawl.browser.identity.platforms.windows"),
            },
            {
              value: "macos",
              label: t("crawl.browser.identity.platforms.macos"),
            },
            {
              value: "linux",
              label: t("crawl.browser.identity.platforms.linux"),
            },
            {
              value: "android",
              label: t("crawl.browser.identity.platforms.android"),
            },
            {
              value: "ios",
              label: t("crawl.browser.identity.platforms.ios"),
            },
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
            {
              value: "chrome",
              label: t("crawl.browser.identity.browsers.chrome"),
            },
            {
              value: "firefox",
              label: t("crawl.browser.identity.browsers.firefox"),
            },
            {
              value: "safari",
              label: t("crawl.browser.identity.browsers.safari"),
            },
            {
              value: "edge",
              label: t("crawl.browser.identity.browsers.edge"),
            },
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
            {
              value: "desktop",
              label: t("crawl.browser.identity.devices.desktop"),
            },
            {
              value: "mobile",
              label: t("crawl.browser.identity.devices.mobile"),
            },
            {
              value: "tablet",
              label: t("crawl.browser.identity.devices.tablet"),
            },
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
        <Input
          placeholder={t("crawl.browser.identity.placeholders.locale")}
          maxLength={16}
        />
      </Form.Item>
      <Form.Item
        label={t("crawl.browser.identity.timezoneId")}
        name="timezoneId"
        extra={t("crawl.browser.identity.timezoneHint")}
      >
        <Input
          placeholder={t("crawl.browser.identity.placeholders.timezone")}
          maxLength={64}
        />
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
      <BrowserHeadersCookiesFields />
    </Card>
  );
}
