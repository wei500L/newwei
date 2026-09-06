"use client";

/**
 * Create Crawl Task 抽屉的浏览器 headers/cookies 列表（FE-批5B：自
 * CreateCrawlTaskDrawer.tsx 拆出）。渲染在身份卡内尾部；自动填充按钮读取
 * 全量表单值派生 sec-ch/sec-fetch 头，并保留用户显式条目（merge 语义）。
 */

import { MinusCircleOutlined, PlusOutlined } from "@ant-design/icons";
import { Button, Form, Input, Space, Typography } from "antd";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";

import {
  buildAutoBrowserHeadersForCrawlOptions,
  mergeBrowserHeaders,
  normalizeBrowserHeaders,
} from "@/lib/crawl-browser-headers";

import type { CreateCrawlTaskFormValues } from "../../types";

export function BrowserHeadersCookiesFields() {
  const { t } = useTranslation();
  const form = Form.useFormInstance<CreateCrawlTaskFormValues>();

  const applyAutoBrowserHeaders = useCallback(() => {
    const currentValues = form.getFieldsValue(
      true,
    ) as Partial<CreateCrawlTaskFormValues>;
    const autoHeaders = buildAutoBrowserHeadersForCrawlOptions(
      currentValues as Record<string, unknown>,
    );
    const currentHeaders = normalizeBrowserHeaders(
      form.getFieldValue("browserHeaders"),
    );
    const mergedHeaders = mergeBrowserHeaders(currentHeaders, autoHeaders);

    form.setFields([
      {
        name: "browserHeaders",
        value: mergedHeaders,
      },
    ]);
  }, [form]);

  return (
    <>
      <Space style={{ marginBottom: 8 }}>
        <Button size="small" onClick={applyAutoBrowserHeaders}>
          {t("crawl.browser.headers.autoFillSecCh")}
        </Button>
        <Typography.Text type="secondary">
          {t("crawl.browser.headers.autoFillSecChHint")}
        </Typography.Text>
      </Space>
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
                  <Input
                    placeholder={t("crawl.browser.headers.placeholders.name")}
                  />
                </Form.Item>
                <Form.Item name={[field.name, "value"]} style={{ flex: 2 }}>
                  <Input
                    placeholder={t("crawl.browser.headers.placeholders.value")}
                  />
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
                  <Input
                    placeholder={t("crawl.browser.cookies.placeholders.name")}
                  />
                </Form.Item>
                <Form.Item name={[field.name, "value"]} style={{ flex: 2 }}>
                  <Input
                    placeholder={t("crawl.browser.cookies.placeholders.value")}
                  />
                </Form.Item>
                <Form.Item
                  name={[field.name, "domain"]}
                  style={{ flex: 1.3 }}
                >
                  <Input
                    placeholder={t("crawl.browser.cookies.placeholders.domain")}
                  />
                </Form.Item>
                <Form.Item name={[field.name, "path"]} style={{ flex: 1 }}>
                  <Input
                    placeholder={t("crawl.browser.cookies.placeholders.path")}
                  />
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
    </>
  );
}
