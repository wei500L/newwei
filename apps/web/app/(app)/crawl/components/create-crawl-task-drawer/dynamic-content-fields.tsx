"use client";

/**
 * Create Crawl Task 抽屉的交互行为与动态内容（FE-批5B：自 CreateCrawlTaskDrawer.tsx 拆出）。
 * 视口/用户模拟三个开关、politeness 卡（延迟/信号量）、dynamic 卡
 * （jsCode 列表、jsOnly、等待条件组）。字段顺序保持拆分前实现。
 */

import { MinusCircleOutlined, PlusOutlined } from "@ant-design/icons";
import { Button, Card, Form, Input, InputNumber, Select, Space, Switch, Typography } from "antd";
import { useTranslation } from "react-i18next";

export function DynamicContentFields() {
  const { t } = useTranslation();
  return (
    <>
      <Form.Item
        label={t("crawl.settings.adjustViewport")}
        name="adjustViewportToContent"
        valuePropName="checked"
        extra={
          <span>
            {t("crawl.settings.adjustViewportHint")}{" "}
            <Typography.Link
              href="https://github.com/unclecode/crawl4ai/blob/main/docs/md_v2/blog/releases/0.4.1.md"
              target="_blank"
              rel="noreferrer"
            >
              {t("crawl.settings.adjustViewportLink")}
            </Typography.Link>
            {t("common.punctuation.period")}
          </span>
        }
      >
        <Switch />
      </Form.Item>
      <Form.Item
        label={t("crawl.settings.simulateUser")}
        name="simulateUser"
        valuePropName="checked"
        extra={t("crawl.settings.simulateUserHint")}
      >
        <Switch />
      </Form.Item>
      <Form.Item
        label={t("crawl.settings.overrideNavigator")}
        name="overrideNavigator"
        valuePropName="checked"
        extra={t("crawl.settings.overrideNavigatorHint")}
      >
        <Switch />
      </Form.Item>
      <Card
        title={t("crawl.settings.politeness.title")}
        size="small"
        style={{ marginBottom: 16 }}
      >
        <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
          {t("crawl.settings.politeness.description")}
        </Typography.Paragraph>
        <Form.Item
          label={t("crawl.settings.politeness.meanDelay")}
          name="meanDelayMs"
          extra={t("crawl.settings.politeness.meanDelayHint")}
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
          name="maxDelayRangeMs"
          extra={t("crawl.settings.politeness.maxRangeHint")}
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
          name="semaphoreCount"
          extra={t("crawl.settings.politeness.semaphoreCountHint")}
        >
          <InputNumber
            min={1}
            max={50}
            style={{ width: "100%" }}
            placeholder={t(
              "crawl.settings.politeness.placeholders.semaphoreCount",
            )}
          />
        </Form.Item>
      </Card>
      <Card
        title={t("crawl.dynamic.title")}
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
          {t("crawl.dynamic.description")}
        </Typography.Paragraph>
        <Form.List name="jsCode">
          {(fields, { add, remove }) => (
            <Space direction="vertical" style={{ width: "100%" }}>
              {fields.map((field, index) => (
                <Space key={field.key} align="start">
                  <Form.Item
                    {...field}
                    label={t("crawl.dynamic.jsStep", { index: index + 1 })}
                    style={{ flex: 1 }}
                    rules={[
                      {
                        required: true,
                        message: t("crawl.dynamic.jsRequired"),
                      },
                    ]}
                  >
                    <Input.TextArea
                      rows={3}
                      placeholder={t("crawl.dynamic.placeholders.jsSnippet")}
                    />
                  </Form.Item>
                  <Button
                    type="link"
                    danger
                    icon={<MinusCircleOutlined />}
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
                {t("crawl.dynamic.addJsStep")}
              </Button>
            </Space>
          )}
        </Form.List>
        <Form.Item
          label={t("crawl.dynamic.jsOnly")}
          name="jsOnly"
          valuePropName="checked"
          extra={t("crawl.dynamic.jsOnlyHint")}
        >
          <Switch />
        </Form.Item>
        <Form.Item
          label={t("crawl.dynamic.waitForSelector")}
          name="waitForSelector"
          extra={t("crawl.dynamic.waitForSelectorHint")}
        >
          <Input placeholder={t("crawl.dynamic.placeholders.selector")} />
        </Form.Item>
        <Form.Item
          label={t("crawl.dynamic.waitForScript")}
          name="waitForScript"
          extra={t("crawl.dynamic.waitForScriptHint")}
        >
          <Input.TextArea
            rows={3}
            placeholder={t("crawl.dynamic.placeholders.script")}
          />
        </Form.Item>
        <Form.Item
          label={t("crawl.dynamic.waitTimeout")}
          name="waitForTimeoutMs"
          extra={t("crawl.dynamic.waitTimeoutHint")}
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
          name="waitUntil"
          extra={t("crawl.dynamic.waitUntilHint")}
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
          name="pageTimeoutMs"
          extra={t("crawl.dynamic.pageTimeoutHint")}
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
          name="delayBeforeReturnHtmlMs"
          extra={t("crawl.dynamic.delayBeforeReturnHtmlHint")}
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
          label={t("crawl.dynamic.removeForms")}
          name="removeForms"
          valuePropName="checked"
          extra={t("crawl.dynamic.removeFormsHint")}
        >
          <Switch />
        </Form.Item>
      </Card>
    </>
  );
}
