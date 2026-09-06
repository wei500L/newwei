"use client";

/**
 * Create Crawl Task 抽屉的 multi URL 嵌套 virtual scroll（FE-批5B：自
 * CreateCrawlTaskDrawer.tsx 拆出）。开关经共享 toggleVirtualScroll 写入
 * 嵌套字面量路径（MultiUrlVirtualScrollPath——消除历史 8 处 as any）；
 * 条件渲染沿用 shouldUpdate 派生（嵌套路径超出 useWatch 元组重载深度）。
 * 字段组复用根级共享组件——共享字段语义但不共享错误 path。
 */

import type { FormListFieldData } from "antd";
import { Form, Switch, Typography } from "antd";
import { useTranslation } from "react-i18next";

import type { CreateCrawlTaskFormValues } from "../../types";
import {
  VirtualScrollLeadingItems,
  VirtualScrollPixelsItem,
  VirtualScrollTrailingItems,
  toggleVirtualScroll,
} from "./virtual-scroll-fields";

export interface MultiUrlVirtualScrollFieldsProps {
  field: FormListFieldData;
}

export function MultiUrlVirtualScrollFields({
  field,
}: MultiUrlVirtualScrollFieldsProps) {
  const { t } = useTranslation();
  const form = Form.useFormInstance<CreateCrawlTaskFormValues>();
  return (
    <>
      <Typography.Text strong style={{ marginBottom: 8, display: "block" }}>
        {t("crawl.virtualScroll.title")}
      </Typography.Text>
      <Form.Item
        label={t("crawl.virtualScroll.enable")}
        name={[field.name, "options", "virtualScroll", "enabled"]}
        valuePropName="checked"
      >
        <Switch
          onChange={(enabled) =>
            toggleVirtualScroll(
              form,
              {
                virtualScroll: [
                  "multiUrlConfigs",
                  field.name,
                  "options",
                  "virtualScroll",
                ],
                scanFullPage: [
                  "multiUrlConfigs",
                  field.name,
                  "options",
                  "scanFullPage",
                ],
                scrollDelayMs: [
                  "multiUrlConfigs",
                  field.name,
                  "options",
                  "scrollDelayMs",
                ],
              },
              enabled,
            )
          }
        />
      </Form.Item>
      <Form.Item
        noStyle
        shouldUpdate={(prev, next) => {
          const prevEnabled =
            prev?.multiUrlConfigs?.[field.name]?.options?.virtualScroll
              ?.enabled;
          const nextEnabled =
            next?.multiUrlConfigs?.[field.name]?.options?.virtualScroll
              ?.enabled;
          return prevEnabled !== nextEnabled;
        }}
      >
        {() => {
          const enabled = Boolean(
            form.getFieldValue([
              "multiUrlConfigs",
              field.name,
              "options",
              "virtualScroll",
              "enabled",
            ]),
          );
          if (!enabled) {
            return null;
          }
          return (
            <>
              <VirtualScrollLeadingItems
                basePath={[
                  "multiUrlConfigs",
                  field.name,
                  "options",
                  "virtualScroll",
                ]}
              />
              <Form.Item
                noStyle
                shouldUpdate={(prev, next) => {
                  const prevValue =
                    prev?.multiUrlConfigs?.[field.name]?.options?.virtualScroll
                      ?.scrollBy;
                  const nextValue =
                    next?.multiUrlConfigs?.[field.name]?.options?.virtualScroll
                      ?.scrollBy;
                  return prevValue !== nextValue;
                }}
              >
                {() => {
                  const scrollBy = form.getFieldValue([
                    "multiUrlConfigs",
                    field.name,
                    "options",
                    "virtualScroll",
                    "scrollBy",
                  ]);
                  if (scrollBy !== "pixels") {
                    return null;
                  }
                  return (
                    <VirtualScrollPixelsItem
                      basePath={[
                        "multiUrlConfigs",
                        field.name,
                        "options",
                        "virtualScroll",
                      ]}
                    />
                  );
                }}
              </Form.Item>
              <VirtualScrollTrailingItems
                basePath={[
                  "multiUrlConfigs",
                  field.name,
                  "options",
                  "virtualScroll",
                ]}
              />
            </>
          );
        }}
      </Form.Item>
    </>
  );
}
