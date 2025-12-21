"use client";

import { Select } from "antd";
import { useTranslation } from "react-i18next";

import { changeLanguage, resolveLocale, type SupportedLocale } from "@/lib/i18n";

export function LanguageSwitcher() {
  const { i18n, t } = useTranslation();
  const current = resolveLocale(i18n.language);

  return (
    <Select
      size="small"
      value={current}
      onChange={(value) => void changeLanguage(value as SupportedLocale)}
      options={[
        { value: "zh-CN", label: t("language.chinese") },
        { value: "en-US", label: t("language.english") }
      ]}
      aria-label={t("language.label")}
      style={{ minWidth: 120 }}
    />
  );
}
