"use client";

/**
 * Create Crawl Task 抽屉的控制器（FE-批5B：自 CreateCrawlTaskDrawer.tsx 拆出）。
 *
 * 职责：三步导航（currentStep）、模板选择与默认模板初始化、
 * waitUntil=networkidle 的 timeout 规范化、关闭复位。
 * 不持有父级 mutation/API 请求——Form 实例与最终 onSubmit 均由父组件持有。
 */

import { Form, type FormInstance } from "antd";
import { useCallback, useEffect, useRef, useState } from "react";

import { resolveCrawlTaskTemplateKey } from "@/lib/crawl-presets";

import type { CreateCrawlTaskFormValues } from "../../types";

import {
  buildTemplateFormValues,
  hasCreateCrawlTaskTemplateKey,
} from "./template-model";

export interface UseCreateCrawlTaskDrawerOptions {
  form: FormInstance<CreateCrawlTaskFormValues>;
  open: boolean;
  canWriteItems: boolean;
  defaultTemplateKey?: string;
  onClose: () => void;
}

export interface CreateCrawlTaskDrawerController {
  currentStep: number;
  selectedTemplate: string;
  handleNext: () => Promise<void>;
  handlePrev: () => void;
  handleTemplateSelect: (templateKey: string) => void;
  resetAndClose: () => void;
}

export function useCreateCrawlTaskDrawer(
  options: UseCreateCrawlTaskDrawerOptions,
): CreateCrawlTaskDrawerController {
  const { form, open, canWriteItems, defaultTemplateKey, onClose } = options;
  const [currentStep, setCurrentStep] = useState(0);
  const [selectedTemplate, setSelectedTemplate] = useState("general");

  const waitUntilValue = Form.useWatch("waitUntil", form);

  useEffect(() => {
    if (waitUntilValue !== "networkidle") {
      return;
    }
    const currentTimeout = form.getFieldValue("waitForTimeoutMs");
    if (typeof currentTimeout === "number" && currentTimeout >= 5000) {
      return;
    }
    form.setFields([{ name: "waitForTimeoutMs", value: 5000 }]);
  }, [form, waitUntilValue]);

  const handleTemplateSelect = useCallback(
    (templateKey: string) => {
      setSelectedTemplate(templateKey);
      const resolvedKey = resolveCrawlTaskTemplateKey(templateKey) ?? "general";
      form.setFieldsValue(
        buildTemplateFormValues(resolvedKey, { canWriteItems }),
      );
      form.setFields([{ name: "headless", value: undefined }]);
    },
    [canWriteItems, form],
  );

  // 会话级一次性初始化（FE-TPL-01）：defaultTemplateKey 只是本次打开会话的
  // 初始默认值，不是受控值——会话内用户主动选择优先，初始化 effect 不再随
  // selectedTemplate 变化重放。关闭时复位会话标记，与两个父组件的 reset
  // 行为对齐（news-sources 关闭即 reset → 重开重新应用默认值；
  // crawl-tasks 保留草稿 → 草稿保护跳过）。
  const sessionInitializedRef = useRef(false);

  useEffect(() => {
    if (!open) {
      sessionInitializedRef.current = false;
      return;
    }
    if (sessionInitializedRef.current) {
      return;
    }
    sessionInitializedRef.current = true;
    // 草稿保护：已填写 URL 或表单已有值（含上次会话遗留）时不覆盖。
    // 不依赖 isFieldsTouched：字段注册前其为空数组恒真（历史实现曾因此
    // 使冷启动的回退分支失效）。
    const hasUrl =
      typeof form.getFieldValue("url") === "string" &&
      form.getFieldValue("url")?.trim()?.length > 0;
    const storeValues = form.getFieldsValue(true) as Record<string, unknown>;
    if (hasUrl || Object.keys(storeValues).length > 0) {
      return;
    }
    const normalizedKey = defaultTemplateKey?.trim();
    if (normalizedKey && hasCreateCrawlTaskTemplateKey(normalizedKey)) {
      handleTemplateSelect(normalizedKey);
      return;
    }
    handleTemplateSelect(selectedTemplate);
  }, [defaultTemplateKey, form, handleTemplateSelect, open, selectedTemplate]);

  const handleNext = async () => {
    try {
      if (currentStep === 1) {
        await form.validateFields(["displayName", "url"]);
      }
      setCurrentStep(currentStep + 1);
    } catch {
      // Validation failed
    }
  };

  const handlePrev = () => {
    setCurrentStep(currentStep - 1);
  };

  const resetAndClose = () => {
    setCurrentStep(0);
    onClose();
  };

  return {
    currentStep,
    selectedTemplate,
    handleNext,
    handlePrev,
    handleTemplateSelect,
    resetAndClose,
  };
}
