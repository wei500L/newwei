"use client";

/**
 * Create Crawl Task 抽屉的模板步（FE-批5B：自 CreateCrawlTaskDrawer.tsx 拆出）。
 * 五个模板卡的选择状态与点击选择；布局/图标/选中边框保持拆分前实现。
 */

import { Card, Col, Row, Space, Typography } from "antd";
import { useTranslation } from "react-i18next";

import type { CreateCrawlTaskTemplate } from "./template-model";

export interface TemplateStepProps {
  templates: CreateCrawlTaskTemplate[];
  selectedTemplate: string;
  onSelect: (templateKey: string) => void;
}

export function TemplateStep({
  templates,
  selectedTemplate,
  onSelect,
}: TemplateStepProps) {
  const { t } = useTranslation();
  return (
    <>
      <Typography.Title level={5}>
        {t("crawl.templates.selectTitle")}
      </Typography.Title>
      <Row gutter={[16, 16]}>
        {templates.map((template) => (
          <Col span={12} key={template.key}>
            <Card
              hoverable
              onClick={() => onSelect(template.key)}
              className={
                selectedTemplate === template.key ? "border-primary" : ""
              }
              style={{
                borderColor:
                  selectedTemplate === template.key ? "#1677ff" : undefined,
                borderWidth: selectedTemplate === template.key ? 2 : 1,
                height: "100%",
              }}
            >
              <Space
                direction="vertical"
                align="center"
                style={{ width: "100%" }}
              >
                <div style={{ fontSize: 24, color: "#1677ff" }}>
                  {template.icon}
                </div>
                <Typography.Text strong>
                  {t(template.label, {
                    defaultValue: template.defaultLabel,
                  })}
                </Typography.Text>
                <Typography.Text
                  type="secondary"
                  style={{ fontSize: 12, textAlign: "center" }}
                >
                  {t(template.description, {
                    defaultValue: template.defaultDescription,
                  })}
                </Typography.Text>
              </Space>
            </Card>
          </Col>
        ))}
      </Row>
    </>
  );
}
