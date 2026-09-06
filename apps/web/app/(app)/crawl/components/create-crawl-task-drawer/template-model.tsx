"use client";

/**
 * Create Crawl Task 抽屉的模板模型（FE-批5B：自 CreateCrawlTaskDrawer.tsx 拆出）。
 * 模板描述符、图标映射与模板表单值的规范化（headless → headlessMode 转换、
 * 兜底默认值），纯数据/纯函数，无 Form 或 React 状态依赖。
 */

import {
  GlobalOutlined,
  ReadOutlined,
  RobotOutlined,
  TeamOutlined,
} from "@ant-design/icons";
import type { ReactNode } from "react";

import {
  CRAWL_TASK_TEMPLATE_DESCRIPTORS,
  buildCrawlTaskTemplateValues,
  type CrawlTaskTemplateKey,
} from "@/lib/crawl-presets";

import type { CreateCrawlTaskFormValues } from "../../types";

const TEMPLATE_ICONS: Record<CrawlTaskTemplateKey, ReactNode> = {
  general: <GlobalOutlined />,
  news: <ReadOutlined />,
  reuters_cf: <RobotOutlined />,
  forum: <TeamOutlined />,
  social: <RobotOutlined />,
};

export interface CreateCrawlTaskTemplate {
  key: CrawlTaskTemplateKey;
  label: string;
  defaultLabel: string;
  description: string;
  defaultDescription: string;
  icon: ReactNode;
}

export const CREATE_CRAWL_TASK_TEMPLATES: CreateCrawlTaskTemplate[] =
  CRAWL_TASK_TEMPLATE_DESCRIPTORS.map((template) => ({
    ...template,
    icon: TEMPLATE_ICONS[template.key],
  }));

export const hasCreateCrawlTaskTemplateKey = (key: string): boolean =>
  CREATE_CRAWL_TASK_TEMPLATES.some((template) => template.key === key);

export interface BuildTemplateFormValuesOptions {
  canWriteItems: boolean;
}

/**
 * 将模板预设转换为可直接 setFieldsValue 的表单值：
 * - headless 布尔转换为 headlessMode（auto/headless/headed）；
 * - userAgentMode/enableStealthMode/simulateUser/overrideNavigator 兜底；
 * - legacy headless 字段显式清空（undefined，不携带值）。
 */
export const buildTemplateFormValues = (
  key: CrawlTaskTemplateKey,
  options: BuildTemplateFormValuesOptions,
): Partial<CreateCrawlTaskFormValues> => {
  const templateValues = buildCrawlTaskTemplateValues(key, {
    canWriteItems: options.canWriteItems,
  });
  return {
    ...templateValues,
    headlessMode:
      typeof templateValues.headless === "boolean"
        ? templateValues.headless
          ? "headless"
          : "headed"
        : "auto",
    userAgentMode: templateValues.userAgentMode ?? "random",
    enableStealthMode: templateValues.enableStealthMode ?? true,
    simulateUser: templateValues.simulateUser ?? true,
    overrideNavigator: templateValues.overrideNavigator ?? true,
    headless: undefined,
  };
};
