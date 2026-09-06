"use client";

/**
 * Create Crawl Task 抽屉的基础信息步（FE-批5B：自 CreateCrawlTaskDrawer.tsx 拆出）。
 * displayName（80 字符上限）与 url（必填）；校验规则与字段顺序保持拆分前实现。
 */

import { Form, Input } from "antd";
import { useTranslation } from "react-i18next";

export function BasicStep() {
  const { t } = useTranslation();
  return (
    <>
      <Form.Item
        label={t("crawl.settings.displayName")}
        name="displayName"
        rules={[
          {
            max: 80,
            message: t("crawl.settings.validation.displayNameMax", {
              count: 80,
            }),
          },
        ]}
      >
        <Input placeholder={t("crawl.settings.placeholders.displayName")} />
      </Form.Item>
      <Form.Item
        label={t("crawl.settings.targetUrl")}
        name="url"
        rules={[
          {
            required: true,
            message: t("crawl.settings.validation.urlRequired"),
          },
        ]}
      >
        <Input placeholder={t("crawl.settings.placeholders.url")} />
      </Form.Item>
    </>
  );
}
