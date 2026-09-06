"use client";

/**
 * Create Crawl Task 抽屉的控制器（FE-批5B：自 CreateCrawlTaskDrawer.tsx 拆出）。
 *
 * 职责：三步导航（currentStep）、模板选择与默认模板初始化、
 * waitUntil=networkidle 的 timeout 规范化、关闭复位。
 * 不持有父级 mutation/API 请求——Form 实例与最终 onSubmit 均由父组件持有。
 */

import { Form, type FormInstance } from "antd";
import { useCallback, useEffect, useState } from "react";

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

  useEffect(() => {
    if (!open) {
      return;
    }
    const normalizedKey = defaultTemplateKey?.trim();
    if (!normalizedKey) {
      return;
    }
    if (normalizedKey === selectedTemplate) {
      return;
    }
    if (!hasCreateCrawlTaskTemplateKey(normalizedKey)) {
      return;
    }
    handleTemplateSelect(normalizedKey);
  }, [defaultTemplateKey, handleTemplateSelect, open, selectedTemplate]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const hasUrl =
      typeof form.getFieldValue("url") === "string" &&
      form.getFieldValue("url")?.trim()?.length > 0;
    if (hasUrl || form.isFieldsTouched(true)) {
      return;
    }
    const normalizedKey = defaultTemplateKey?.trim();
    if (
      normalizedKey &&
      hasCreateCrawlTaskTemplateKey(normalizedKey)
    ) {
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
