"use client";

/**
 * Create Crawl Task 抽屉的 multi URL 策略动态覆盖（FE-批5B：自
 * CreateCrawlTaskDrawer.tsx 拆出）。策略级 jsCode 列表、jsOnly 与
 * 等待/礼貌字段组（placeholders 使用 *Alt 文案，与根级区分）。
 */

import { MinusCircleOutlined, PlusOutlined } from "@ant-design/icons";
import type { FormListFieldData } from "antd";
import { Button, Form, Input, InputNumber, Select, Space, Switch, Typography } from "antd";
import { useTranslation } from "react-i18next";

export interface MultiUrlOverridesFieldsProps {
  field: FormListFieldData;
}

export function MultiUrlOverridesFields({
  field,
}: MultiUrlOverridesFieldsProps) {
  const { t } = useTranslation();
  return (
    <>
      <Typography.Text strong style={{ marginBottom: 8, display: "block" }}>
        {t("crawl.multiUrl.dynamicOverrides")}
      </Typography.Text>
      <Form.List name={[field.name, "options", "jsCode"]}>
        {(jsFields, { add: addJs, remove: removeJs }) => (
          <Space direction="vertical" style={{ width: "100%" }}>
            {jsFields.map((jsField, jsIndex) => (
              <Space key={jsField.key} align="start">
                <Form.Item
                  {...jsField}
                  label={t("crawl.dynamic.jsStep", {
                    index: jsIndex + 1,
                  })}
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
      <Form.Item
        label={t("crawl.dynamic.waitUntil")}
        name={[field.name, "options", "waitUntil"]}
      >
        <Select
          allowClear
          placeholder={t("crawl.dynamic.placeholders.waitUntil")}
          options={[
            {
              value: "domcontentloaded",
              label: t("crawl.dynamic.waitUntilOptions.domcontentloaded"),
            },
            {
              value: "load",
              label: t("crawl.dynamic.waitUntilOptions.load"),
            },
            {
              value: "networkidle",
              label: t("crawl.dynamic.waitUntilOptions.networkidle"),
            },
            {
              value: "commit",
              label: t("crawl.dynamic.waitUntilOptions.commit"),
            },
          ]}
        />
      </Form.Item>
      <Form.Item
        label={t("crawl.dynamic.pageTimeout")}
        name={[field.name, "options", "pageTimeoutMs"]}
      >
        <InputNumber
          min={1000}
          max={180000}
          style={{ width: "100%" }}
          placeholder={t("crawl.dynamic.placeholders.pageTimeout")}
        />
      </Form.Item>
      <Form.Item
        label={t("crawl.dynamic.delayBeforeReturnHtml")}
        name={[field.name, "options", "delayBeforeReturnHtmlMs"]}
      >
        <InputNumber
          min={0}
          max={30000}
          step={100}
          style={{ width: "100%" }}
          placeholder={t("crawl.dynamic.placeholders.delayBeforeReturnHtml")}
        />
      </Form.Item>
      <Form.Item
        label={t("crawl.settings.politeness.meanDelay")}
        name={[field.name, "options", "meanDelayMs"]}
      >
        <InputNumber
          min={0}
          max={10000}
          step={50}
          style={{ width: "100%" }}
          placeholder={t("crawl.settings.politeness.placeholders.meanDelay")}
        />
      </Form.Item>
      <Form.Item
        label={t("crawl.settings.politeness.maxRange")}
        name={[field.name, "options", "maxDelayRangeMs"]}
      >
        <InputNumber
          min={0}
          max={10000}
          step={50}
          style={{ width: "100%" }}
          placeholder={t("crawl.settings.politeness.placeholders.maxRange")}
        />
      </Form.Item>
      <Form.Item
        label={t("crawl.settings.politeness.semaphoreCount")}
        name={[field.name, "options", "semaphoreCount"]}
      >
        <InputNumber
          min={1}
          max={50}
          style={{ width: "100%" }}
          placeholder={t("crawl.settings.politeness.placeholders.semaphoreCount")}
        />
      </Form.Item>
      <Form.Item
        label={t("crawl.dynamic.removeForms")}
        name={[field.name, "options", "removeForms"]}
        valuePropName="checked"
      >
        <Switch />
      </Form.Item>
    </>
  );
}
