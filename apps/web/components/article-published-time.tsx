"use client";

import { Space, Typography } from "antd";
import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import {
  formatDateTime,
  formatRelativeTime,
  type SupportedLocale,
} from "@/lib/i18n";

const DEFAULT_PUBLISHED_FORMAT: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  timeZoneName: "short",
};

const resolveFormatOptions = (
  formatOptions: Intl.DateTimeFormatOptions | undefined,
  timeZone: string | undefined,
): Intl.DateTimeFormatOptions => {
  if (formatOptions) {
    return timeZone ? { ...formatOptions, timeZone } : formatOptions;
  }
  return timeZone
    ? { ...DEFAULT_PUBLISHED_FORMAT, timeZone }
    : DEFAULT_PUBLISHED_FORMAT;
};

export interface ResolvedArticlePublishedTime {
  primaryText: string;
  relativeText: string | null;
  isUnknown: boolean;
}

export interface ResolveArticlePublishedTimeOptions {
  publishedAt?: string | null;
  locale: SupportedLocale;
  timeZone?: string;
  formatOptions?: Intl.DateTimeFormatOptions;
  showRelative?: boolean;
  unknownText: string;
}

export function resolveArticlePublishedTime({
  publishedAt,
  locale,
  timeZone,
  formatOptions,
  showRelative = true,
  unknownText,
}: ResolveArticlePublishedTimeOptions): ResolvedArticlePublishedTime {
  const normalizedPublishedAt =
    typeof publishedAt === "string" ? publishedAt.trim() : publishedAt;
  if (!normalizedPublishedAt) {
    return {
      primaryText: unknownText,
      relativeText: null,
      isUnknown: true,
    };
  }

  const primaryText = formatDateTime(
    normalizedPublishedAt,
    locale,
    resolveFormatOptions(formatOptions, timeZone),
  );
  if (!primaryText) {
    return {
      primaryText: unknownText,
      relativeText: null,
      isUnknown: true,
    };
  }

  const relativeText = showRelative
    ? formatRelativeTime(normalizedPublishedAt, locale, { timeZone }) || null
    : null;

  return {
    primaryText,
    relativeText,
    isUnknown: false,
  };
}

export interface ArticlePublishedTimeProps {
  publishedAt?: string | null;
  locale: SupportedLocale;
  timeZone?: string;
  formatOptions?: Intl.DateTimeFormatOptions;
  showLabel?: boolean;
  showRelative?: boolean;
  label?: string;
  unknownText?: string;
  primaryStrong?: boolean;
  className?: string;
  primaryClassName?: string;
  secondaryClassName?: string;
  secondaryStyle?: CSSProperties;
}

export function ArticlePublishedTime({
  publishedAt,
  locale,
  timeZone,
  formatOptions,
  showLabel = true,
  showRelative = true,
  label,
  unknownText,
  primaryStrong = false,
  className,
  primaryClassName,
  secondaryClassName,
  secondaryStyle,
}: ArticlePublishedTimeProps) {
  const { t } = useTranslation();
  const publishedLabel = label ?? t("items.time.published");
  const publishedUnknown = unknownText ?? t("items.time.publishedUnknown");
  const resolved = resolveArticlePublishedTime({
    publishedAt,
    locale,
    timeZone,
    formatOptions,
    showRelative,
    unknownText: publishedUnknown,
  });

  return (
    <Space direction="vertical" size={0} className={className}>
      <Typography.Text strong={primaryStrong} className={primaryClassName}>
        {showLabel
          ? `${publishedLabel}: ${resolved.primaryText}`
          : resolved.primaryText}
      </Typography.Text>
      {resolved.relativeText ? (
        <Typography.Text
          type="secondary"
          className={secondaryClassName}
          style={secondaryStyle}
        >
          {resolved.relativeText}
        </Typography.Text>
      ) : null}
    </Space>
  );
}
