"use client";

import { Select } from "antd";
import { useTranslation } from "react-i18next";

import { resolveLocale, type SupportedLocale } from "@/lib/i18n";
import { changeLanguage } from "@/lib/i18n-client";

interface LanguageSwitcherProps {
  compact?: boolean;
}

export function LanguageSwitcher({ compact = false }: LanguageSwitcherProps) {
  const { i18n, t } = useTranslation();
  const current = resolveLocale(i18n.language);
  const options = [
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
      style={{ width: compact ? 112 : 118 }}
      popupMatchSelectWidth={false}
    />
  );
}
