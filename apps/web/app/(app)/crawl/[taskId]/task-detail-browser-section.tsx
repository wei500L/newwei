"use client";

/**
 * Crawl Task Detail 浏览器形态字段段（FE-批5A：自 task-detail.tsx 拆出）。
 * headless/隐身/反爬/托管浏览器/UA 及生成器/locale/时区/地理位置/
 * 自定义 headers/cookies/会话与存储态共 18 项。
 */

import { Descriptions, Space, Typography } from "antd";
import { useTranslation } from "react-i18next";

import {
  buildBrowserCookies,
  buildBrowserHeaders,
  buildGeolocationSummary,
  buildUserAgentGeneratorSummary,
  resolveBrowserLocale,
  resolveManagedBrowserProfile,
  resolveTimezonePreference,
  resolveUserAgentValue,
} from "./task-detail-browser-model";
import type { CrawlTaskConfig } from "./task-detail-config-core-model";
import {
  buildStorageStatePreview,
  resolveSessionIdentifier,
} from "./task-detail-runtime-model";

export function TaskDetailBrowserSection({
  config,
}: {
  config: CrawlTaskConfig;
}) {
  const { t } = useTranslation();
  const browserHeaders = buildBrowserHeaders(config);
  const browserCookies = buildBrowserCookies(config);
  const managedBrowserProfile = resolveManagedBrowserProfile(config);
  const userAgentValue = resolveUserAgentValue(config);
  const userAgentModeSummary =
    config?.userAgentMode === "random"
      ? t("crawl.detail.userAgent.random")
      : t("crawl.detail.userAgent.default");
  const userAgentGeneratorSummary = buildUserAgentGeneratorSummary(config, t);
  const browserLocale = resolveBrowserLocale(config);
  const timezonePreference = resolveTimezonePreference(config);
  const geolocationSummary = buildGeolocationSummary(config);
  const managedBrowserEnabled = Boolean(config?.useManagedBrowser);

  return (
    <>
      <Descriptions.Item
        label={t("crawl.detail.fields.headless")}
      >
        {typeof config?.headless === "boolean"
          ? config.headless
            ? t("crawl.detail.headless.headless")
            : t("crawl.detail.headless.headed")
          : t("crawl.detail.serverDefault")}
      </Descriptions.Item>
      <Descriptions.Item label={t("crawl.detail.fields.undetectedBrowser")}>
        {config?.enableUndetectedBrowser
          ? t("common.enabled")
          : t("common.disabled")}
      </Descriptions.Item>
      <Descriptions.Item label={t("crawl.detail.fields.stealthMode")}>
        {config?.enableStealthMode
          ? t("common.enabled")
          : t("common.disabled")}
      </Descriptions.Item>
      <Descriptions.Item
        label={t("crawl.detail.fields.antiBotMode")}
      >
        {config?.antiBotMode === "enabled"
          ? t("crawl.detail.antiBotMode.enabled")
          : config?.antiBotMode === "disabled"
            ? t("crawl.detail.antiBotMode.disabled")
            : t("crawl.detail.antiBotMode.auto")}
      </Descriptions.Item>
      <Descriptions.Item label={t("crawl.detail.fields.managedBrowser")}>
        {managedBrowserEnabled ? t("common.enabled") : t("common.disabled")}
      </Descriptions.Item>
      <Descriptions.Item label={t("crawl.detail.fields.userDataDir")}>
        {managedBrowserProfile ?? t("common.emptyValue")}
      </Descriptions.Item>
      <Descriptions.Item label={t("crawl.detail.fields.simulateUser")}>
        {config?.simulateUser ? t("common.enabled") : t("common.disabled")}
      </Descriptions.Item>
      <Descriptions.Item label={t("crawl.detail.fields.overrideNavigator")}>
        {config?.overrideNavigator
          ? t("common.enabled")
          : t("common.disabled")}
      </Descriptions.Item>
      <Descriptions.Item label={t("crawl.detail.fields.userAgent")}>
        {userAgentValue ?? t("crawl.detail.userAgent.default")}
      </Descriptions.Item>
      <Descriptions.Item label={t("crawl.detail.fields.userAgentMode")}>
        {userAgentModeSummary}
      </Descriptions.Item>
      <Descriptions.Item label={t("crawl.detail.fields.uaGenerator")}>
        {userAgentGeneratorSummary ??
          t("crawl.detail.userAgent.notConfigured")}
      </Descriptions.Item>
      <Descriptions.Item label={t("crawl.detail.fields.browserLocale")}>
        {browserLocale ?? t("crawl.detail.serverDefault")}
      </Descriptions.Item>
      <Descriptions.Item label={t("crawl.detail.fields.timezone")}>
        {timezonePreference ?? t("crawl.detail.serverDefault")}
      </Descriptions.Item>
      <Descriptions.Item label={t("crawl.detail.fields.geolocation")}>
        {geolocationSummary ?? t("common.disabled")}
      </Descriptions.Item>
      <Descriptions.Item label={t("crawl.detail.fields.customHeaders")}>
        {browserHeaders.length ? (
          <Space direction="vertical" size={0}>
            {browserHeaders.map((header) => (
              <Typography.Text
                key={header}
                style={{ fontFamily: "monospace" }}
              >
                {header}
              </Typography.Text>
            ))}
          </Space>
        ) : (
          t("common.emptyValue")
        )}
      </Descriptions.Item>
      <Descriptions.Item label={t("crawl.detail.fields.cookies")}>
        {browserCookies.length ? (
          <Space direction="vertical" size={0}>
            {browserCookies.map((cookie) => (
              <Typography.Text
                key={cookie}
                style={{ fontFamily: "monospace" }}
              >
                {cookie}
              </Typography.Text>
            ))}
          </Space>
        ) : (
          t("common.emptyValue")
        )}
      </Descriptions.Item>
      <Descriptions.Item label={t("crawl.detail.fields.sessionId")}>
        {resolveSessionIdentifier(config) ?? t("common.emptyValue")}
      </Descriptions.Item>
      <Descriptions.Item label={t("crawl.detail.fields.storageState")}>
        {buildStorageStatePreview(config) ? (
          <Typography.Text code>
            {buildStorageStatePreview(config)}
          </Typography.Text>
        ) : (
          t("common.emptyValue")
        )}
      </Descriptions.Item>
    </>
  );
}
