"use client";

/**
 * Create Crawl Task 抽屉的编排层（FE-批5B 领域拆分后的公共入口）。
 *
 * 两个消费入口（crawl-tasks / news-sources-modals）继续从本路径导入
 * 同名 export，Props 契约不变。本组件只负责：
 * - Drawer 外壳与三步组合（模板 / 基础 / 高级）；
 * - 提交入口与导航按钮。
 * 不发起 API 请求——Form 实例与最终 onSubmit 由父组件持有；
 * 步骤/模板状态机在 use-create-crawl-task-drawer，高级配置字段在
 * create-crawl-task-drawer/ 领域模块。
 */

import type { FormInstance } from "antd";
import { Button, Drawer, Form, Space, Steps } from "antd";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import type { CreateCrawlTaskFormValues } from "../types";

import { AdvancedStep } from "./create-crawl-task-drawer/advanced-step";
import { BasicStep } from "./create-crawl-task-drawer/basic-step";
import { CREATE_CRAWL_TASK_TEMPLATES } from "./create-crawl-task-drawer/template-model";
import { TemplateStep } from "./create-crawl-task-drawer/template-step";
import { useCreateCrawlTaskDrawer } from "./create-crawl-task-drawer/use-create-crawl-task-drawer";

interface CreateCrawlTaskDrawerProps {
  form: FormInstance<CreateCrawlTaskFormValues>;
  open: boolean;
  loading: boolean;
  canWriteItems: boolean;
  title?: ReactNode;
  submitLabel?: ReactNode;
  defaultTemplateKey?: string;
  onClose: () => void;
  onSubmit: (values: CreateCrawlTaskFormValues) => void | Promise<void>;
}

export function CreateCrawlTaskDrawer({
  form,
  open,
  loading,
  canWriteItems,
  title,
  submitLabel,
  defaultTemplateKey,
  onClose,
  onSubmit,
}: CreateCrawlTaskDrawerProps) {
  const { t } = useTranslation();
  const {
    currentStep,
    selectedTemplate,
    handleNext,
    handlePrev,
    handleTemplateSelect,
    resetAndClose,
  } = useCreateCrawlTaskDrawer({
    form,
    open,
    canWriteItems,
    defaultTemplateKey,
    onClose,
  });

  return (
    <Drawer
      title={title ?? t("crawl.createDrawer.title")}
      placement="right"
      width={600}
      open={open}
      onClose={resetAndClose}
      destroyOnHidden
      extra={
        <Space>
          <Button onClick={resetAndClose}>{t("common.cancel")}</Button>
        </Space>
      }
    >
      <Steps
        current={currentStep}
        items={[
          { title: t("crawl.steps.template") },
          { title: t("crawl.steps.basic") },
          { title: t("crawl.steps.advanced") },
        ]}
        style={{ marginBottom: 24 }}
      />

      <Form
          layout="vertical"
          form={form}
          onFinish={(values) => {
            // FE-SUBMIT-01：loading 期间表单 submit 事件（Enter 提交路径/
            // 编程式 submit）不经过按钮的 disabled——Drawer 边界 fail-closed，
            // 防止重复触发父级 mutation。
            if (loading) {
              return;
            }
            return onSubmit(values);
          }}
        >
        <div style={{ display: currentStep === 0 ? "block" : "none" }}>
          <TemplateStep
            templates={CREATE_CRAWL_TASK_TEMPLATES}
            selectedTemplate={selectedTemplate}
            onSelect={handleTemplateSelect}
          />
        </div>

        <div style={{ display: currentStep === 1 ? "block" : "none" }}>
          <BasicStep />
        </div>

        <div style={{ display: currentStep === 2 ? "block" : "none" }}>
          <AdvancedStep canWriteItems={canWriteItems} />
        </div>

        <div
          style={{
            marginTop: 24,
            display: "flex",
            justifyContent: "space-between",
          }}
        >
          {currentStep > 0 && (
            <Button onClick={handlePrev}>{t("common.previous")}</Button>
          )}
          <div style={{ marginLeft: "auto" }}>
            {currentStep < 2 && (
              <Button type="primary" onClick={handleNext}>
                {t("common.next")}
              </Button>
            )}
            {currentStep === 2 && (
              <Button type="primary" htmlType="submit" loading={loading}>
                {submitLabel ?? t("crawl.createDrawer.submit")}
              </Button>
            )}
          </div>
        </div>
      </Form>
    </Drawer>
  );
}
