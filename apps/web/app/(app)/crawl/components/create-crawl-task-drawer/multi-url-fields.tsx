"use client";

/**
 * Create Crawl Task 抽屉的 multi URL 领域（FE-批5B：自 CreateCrawlTaskDrawer.tsx 拆出）。
 * multiUrlConfigs Form.List：策略增删、空态与策略卡编排。
 */

import { PlusOutlined } from "@ant-design/icons";
import { Button, Form, Space, Typography } from "antd";
import { useTranslation } from "react-i18next";

import { MultiUrlStrategyCard } from "./multi-url-strategy-card";

export function MultiUrlFields() {
  const { t } = useTranslation();
  return (
    <Form.List name="multiUrlConfigs">
      {(fields, { add, remove }) => (
        <Space direction="vertical" style={{ width: "100%" }} size="large">
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <Typography.Text strong>{t("crawl.multiUrl.title")}</Typography.Text>
            <Button
              type="dashed"
              icon={<PlusOutlined />}
              onClick={() => add()}
              size="small"
            >
              {t("crawl.multiUrl.add")}
            </Button>
          </div>
          {fields.length === 0 ? (
            <Typography.Text type="secondary">
              {t("crawl.multiUrl.empty")}
            </Typography.Text>
          ) : null}
          {fields.map((field, index) => (
            <MultiUrlStrategyCard
              key={field.key}
              field={field}
              index={index}
              onRemove={() => remove(field.name)}
            />
          ))}
        </Space>
      )}
    </Form.List>
  );
}
