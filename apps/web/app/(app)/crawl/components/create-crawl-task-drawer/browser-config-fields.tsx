"use client";

/**
 * Create Crawl Task 抽屉的浏览器基础配置（FE-批5B：自 CreateCrawlTaskDrawer.tsx 拆出）。
 * headlessMode（headed 时显示 Xvfb 警告）、undetected/stealth/antiBot、
 * managed browser 与 userDataDir 联动。
 */

import { Alert, Form, Input, Select, Space, Switch, Typography } from "antd";
import { useTranslation } from "react-i18next";

import type { CreateCrawlTaskFormValues } from "../../types";

export function BrowserConfigFields() {
  const { t } = useTranslation();
  const form = Form.useFormInstance<CreateCrawlTaskFormValues>();
  const headlessModeValue = Form.useWatch("headlessMode", form);
  const useManagedBrowserValue = Form.useWatch("useManagedBrowser", form);

  return (
    <>
      <Form.Item
        label={t("crawl.browser.headless")}
        name="headlessMode"
        extra={t("crawl.browser.headlessHint")}
      >
        <Select
          options={[
            {
              value: "auto",
              label: t("crawl.browser.headlessModes.auto"),
            },
            {
              value: "headless",
              label: t("crawl.browser.headlessModes.headless"),
            },
            {
              value: "headed",
              label: t("crawl.browser.headlessModes.headed"),
            },
          ]}
        />
      </Form.Item>
      {headlessModeValue === "headed" ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message={t("crawl.browser.headedWarningTitle")}
          description={
            <Space direction="vertical" size={2}>
              <Typography.Text>
                {t("crawl.browser.headedWarning")}
              </Typography.Text>
              <Typography.Text type="secondary">
                {t("crawl.runtimeGuide.noAutoBootstrap")}
              </Typography.Text>
              <Typography.Text type="secondary">
                {t("crawl.runtimeGuide.principleBody")}
              </Typography.Text>
              <Typography.Text strong>
                {t("crawl.runtimeGuide.stepsTitle")}
              </Typography.Text>
              <Typography.Text type="secondary">
                {`1. ${t("crawl.runtimeGuide.step1")}`}
              </Typography.Text>
              <Typography.Text type="secondary">
                {`2. ${t("crawl.runtimeGuide.step2")}`}
              </Typography.Text>
              <Typography.Text type="secondary">
                {`3. ${t("crawl.runtimeGuide.step3")}`}
              </Typography.Text>
            </Space>
          }
        />
      ) : null}
      <Form.Item
        label={t("crawl.browser.undetected")}
        name="enableUndetectedBrowser"
        valuePropName="checked"
        extra={t("crawl.browser.undetectedHint")}
      >
        <Switch />
      </Form.Item>
      <Form.Item
        label={t("crawl.browser.magicMode")}
        name="enableStealthMode"
        valuePropName="checked"
        extra={t("crawl.browser.magicModeHint")}
      >
        <Switch />
      </Form.Item>
      <Form.Item
        label={t("crawl.browser.antiBotMode")}
        name="antiBotMode"
        extra={t("crawl.browser.antiBotModeHint")}
      >
        <Select
          options={[
            {
              value: "auto",
              label: t("crawl.browser.antiBotModes.auto"),
            },
            {
              value: "enabled",
              label: t("crawl.browser.antiBotModes.enabled"),
            },
            {
              value: "disabled",
              label: t("crawl.browser.antiBotModes.disabled"),
            },
          ]}
        />
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
    </>
  );
}
