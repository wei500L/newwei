"use client";

/**
 * Create Crawl Task 抽屉的会话与代理（FE-批5B：自 CreateCrawlTaskDrawer.tsx 拆出）。
 * sessionId/storageState 卡；proxy 卡依据 proxyUrl/proxyConfig watch 派生
 * 问题清单（出现 legacy 代理字段时 error 级提示）。
 */

import { Alert, Card, Form, Input, Typography } from "antd";
import { useTranslation } from "react-i18next";

import { findUnsupportedProxyIssues } from "@/lib/crawl-config-policy";

import type { CreateCrawlTaskFormValues } from "../../types";

import { formatPolicyIssues } from "./option-guards";

export function SessionProxyFields() {
  const { t } = useTranslation();
  const form = Form.useFormInstance<CreateCrawlTaskFormValues>();
  const proxyUrlValue = Form.useWatch("proxyUrl", form);
  const proxyConfigValue = Form.useWatch("proxyConfig", form);
  const proxyIssues = findUnsupportedProxyIssues(
    {
      proxyUrl: proxyUrlValue,
      proxyConfig: proxyConfigValue,
    },
    "options",
  );

  return (
    <>
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
          <Input
            placeholder={t("crawl.session.placeholders.sessionId")}
            maxLength={160}
          />
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
        <Alert
          type={proxyIssues.length > 0 ? "error" : "warning"}
          showIcon
          message={
            proxyIssues.length > 0
              ? t("crawl.proxy.unsupportedLegacyTitle")
              : t("crawl.proxy.disabledTitle")
          }
          description={
            proxyIssues.length > 0
              ? formatPolicyIssues(proxyIssues, t)
              : t("crawl.proxy.disabledDescription")
          }
        />
      </Card>
    </>
  );
}
