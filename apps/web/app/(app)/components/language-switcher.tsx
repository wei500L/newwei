"use client";

import { Select } from "antd";
import { useTranslation } from "react-i18next";

import { changeLanguage, resolveLocale, type SupportedLocale } from "@/lib/i18n";

interface LanguageSwitcherProps {
  compact?: boolean;
}

export function LanguageSwitcher({ compact = false }: LanguageSwitcherProps) {
  const { i18n, t } = useTranslation();
  const current = resolveLocale(i18n.language);
  const options = compact
    ? [
        { value: "zh-CN", label: "中" },
        { value: "en-US", label: "EN" }
      ]
    : [
        { value: "zh-CN", label: t("language.chinese") },
        { value: "en-US", label: t("language.english") }
      ];

  return (
    <Select
      size="small"
      id="topnav-language"
      value={current}
      onChange={(value) => void changeLanguage(value as SupportedLocale)}
      options={options}
      aria-label={t("language.label")}
      style={{ width: compact ? 76 : 112 }}
      dropdownMatchSelectWidth={false}
    />
  );
}
