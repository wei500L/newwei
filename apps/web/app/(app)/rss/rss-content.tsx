"use client";

import { gql, useQuery } from "@apollo/client";
import { Alert, Card, Empty, Radio, Select, Space, Switch, Typography } from "antd";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import dayjs from "@/lib/dayjs";
import type { FilterState } from "@/app/(app)/items/components/faceted-search";
import {
  isChineseTargetLanguage,
  RSS_TRANSLATION_STATUS_QUERY,
  RSS_TRANSLATION_TARGET_LANGUAGE_OPTIONS,
  type RssTranslationProvider,
  type RssTranslationStatusQuery,
  type RssTranslationStatusQueryVariables
} from "@/lib/rss-translation";

import { ItemsView } from "../items/items-view";
import { RSS_ITEMS_VIEW_PRESET } from "./rss-reader-preset";

const DEFAULT_WINDOW_DAYS = 7;

interface RssSourceOption {
  id: string;
  name: string;
  language?: string | null;
  siteUrl: string;
  feedUrl: string;
  latestItemAt?: string | null;
  itemCountWindow: number;
}

interface RssSourcesQuery {
  rssSources: RssSourceOption[];
}

interface RssSourcesQueryVariables {
  windowDays?: number;
  onlyWithItems?: boolean;
}

const RSS_SOURCES_QUERY = gql`
  query RssSources($windowDays: Int, $onlyWithItems: Boolean) {
    rssSources(windowDays: $windowDays, onlyWithItems: $onlyWithItems) {
      id
      name
      language
      siteUrl
      feedUrl
      latestItemAt
      itemCountWindow
    }
  }
`;

export function RssContent() {
  const { t } = useTranslation();
  const [selectedSourceIds, setSelectedSourceIds] = useState<string[]>([]);
  const [selectionInitialized, setSelectionInitialized] = useState(false);
  const [translationEnabled, setTranslationEnabled] = useState(false);
  const [translationProvider, setTranslationProvider] = useState<RssTranslationProvider>("deeplx");
  const [targetLanguage, setTargetLanguage] = useState("zh-CN");
  const [translationError, setTranslationError] = useState<string | null>(null);
  const initialFilters = useMemo<FilterState>(
    () => ({
      dateRange: [dayjs().subtract(DEFAULT_WINDOW_DAYS - 1, "day").startOf("day"), dayjs().endOf("day")]
    }),
    []
  );

  const { data, loading, error } = useQuery<RssSourcesQuery, RssSourcesQueryVariables>(
    RSS_SOURCES_QUERY,
    {
      variables: {
        windowDays: DEFAULT_WINDOW_DAYS,
        onlyWithItems: true
      },
      fetchPolicy: "cache-and-network"
    }
  );

  const sources = useMemo(() => data?.rssSources ?? [], [data?.rssSources]);

  const { data: translationStatusData } = useQuery<
    RssTranslationStatusQuery,
    RssTranslationStatusQueryVariables
  >(RSS_TRANSLATION_STATUS_QUERY, {
    variables: { targetLanguage },
    fetchPolicy: "cache-and-network"
  });

  const providerStatuses = translationStatusData?.rssTranslationStatus ?? [];
  const selectedProviderStatus = providerStatuses.find(
    (status) => status.provider === translationProvider
  );
  const translationReady = Boolean(
    translationEnabled &&
      selectedProviderStatus?.available &&
      selectedProviderStatus?.targetLanguageSupported
  );

  useEffect(() => {
    if (translationProvider === "deeplx" && !isChineseTargetLanguage(targetLanguage)) {
      setTargetLanguage("zh-CN");
    }
  }, [targetLanguage, translationProvider]);

  useEffect(() => {
    if (sources.length === 0) {
      setSelectedSourceIds([]);
      setSelectionInitialized(false);
      return;
    }

    const sourceIdSet = new Set(sources.map((source) => source.id));
    setSelectedSourceIds((prev) => {
      if (!selectionInitialized) {
        return sources.map((source) => source.id);
      }
      return prev.filter((id) => sourceIdSet.has(id));
    });
    if (!selectionInitialized) {
      setSelectionInitialized(true);
    }
  }, [selectionInitialized, sources]);

  const selectOptions = useMemo(
    () =>
      sources.map((source) => ({
        value: source.id,
        label: `${source.name} (${source.itemCountWindow})`
      })),
    [sources]
  );

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Card className="content-card">
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          <div>
            <Typography.Title level={3} style={{ marginBottom: 8 }}>
              {t("pages.rss.title", { defaultValue: "RSS Reader" })}
            </Typography.Title>
            <Typography.Text type="secondary">
              {t("pages.rss.subtitle", {
                defaultValue: "Read processed articles from RSS sources in a focused stream."
              })}
            </Typography.Text>
            <br />
            <Typography.Text type="secondary">
              {t("pages.rss.readerHint", {
                defaultValue: "Optimized for focused scanning with layered filters."
              })}
            </Typography.Text>
          </div>

          {error ? (
            <Alert
              type="error"
              showIcon
              message={t("pages.rss.loadFailed", { defaultValue: "Failed to load RSS sources." })}
              description={error.message}
            />
          ) : null}

          {!loading && sources.length === 0 ? (
            <Empty description={t("pages.rss.emptySources", { defaultValue: "No RSS sources with recent items were found." })} />
          ) : null}

          {sources.length > 0 ? (
            <Space direction="vertical" size="small" style={{ width: "100%" }}>
              <Typography.Text strong>
                {t("pages.rss.sourceLabel", { defaultValue: "RSS Sources" })}
              </Typography.Text>
              <Select
                mode="multiple"
                allowClear
                style={{ width: "100%" }}
                placeholder={t("pages.rss.sourcePlaceholder", { defaultValue: "Select RSS sources" })}
                options={selectOptions}
                value={selectedSourceIds}
                onChange={(next) => setSelectedSourceIds(next)}
                maxTagCount="responsive"
              />
              <Typography.Text type="secondary">
                {t("pages.rss.selectedCount", {
                  count: selectedSourceIds.length,
                  defaultValue: "{{count}} sources selected"
                })}
              </Typography.Text>
            </Space>
          ) : null}

          <Space direction="vertical" size="small" style={{ width: "100%" }}>
            <Typography.Text strong>
              {t("pages.rss.translation.title", { defaultValue: "Translation" })}
            </Typography.Text>
            <Space wrap>
              <Space>
                <Typography.Text>
                  {t("pages.rss.translation.enable", { defaultValue: "Enable" })}
                </Typography.Text>
                <Switch
                  checked={translationEnabled}
                  onChange={(checked) => {
                    setTranslationError(null);
                    setTranslationEnabled(checked);
                  }}
                />
              </Space>

              <Radio.Group
                value={translationProvider}
                onChange={(event) => {
                  setTranslationError(null);
                  setTranslationProvider(event.target.value as RssTranslationProvider);
                }}
                optionType="button"
                buttonStyle="solid"
                disabled={!translationEnabled}
              >
                <Radio.Button value="deeplx">
                  {t("pages.rss.translation.provider.deeplx", { defaultValue: "DeepLX API" })}
                </Radio.Button>
                <Radio.Button value="llm">
                  {t("pages.rss.translation.provider.llm", { defaultValue: "LLM" })}
                </Radio.Button>
              </Radio.Group>

              <Select
                style={{ minWidth: 160 }}
                value={targetLanguage}
                onChange={(next) => {
                  setTranslationError(null);
                  setTargetLanguage(next);
                }}
                disabled={!translationEnabled || translationProvider === "deeplx"}
                options={RSS_TRANSLATION_TARGET_LANGUAGE_OPTIONS}
              />
            </Space>

            {translationEnabled && selectedProviderStatus && !selectedProviderStatus.available ? (
              <Alert
                type="warning"
                showIcon
                message={t("pages.rss.translation.unavailable", {
                  defaultValue: "Selected translation source is unavailable."
                })}
                description={selectedProviderStatus.message ?? t("common.notAvailable")}
              />
            ) : null}

            {translationEnabled &&
            selectedProviderStatus &&
            selectedProviderStatus.available &&
            !selectedProviderStatus.targetLanguageSupported ? (
              <Alert
                type="warning"
                showIcon
                message={t("pages.rss.translation.targetUnsupported", {
                  defaultValue: "Target language is not supported by selected source."
                })}
                description={selectedProviderStatus.message ?? t("common.notAvailable")}
              />
            ) : null}

            {translationEnabled && translationError ? (
              <Alert
                type="error"
                showIcon
                message={t("pages.rss.translation.failed", { defaultValue: "Translation failed." })}
                description={translationError}
              />
            ) : null}
          </Space>
        </Space>
      </Card>

      {sources.length > 0 && selectedSourceIds.length === 0 ? (
        <Alert
          type="info"
          showIcon
          message={t("pages.rss.sourcePlaceholder", { defaultValue: "Select RSS sources" })}
        />
      ) : null}

      {sources.length > 0 && selectedSourceIds.length > 0 ? (
        <ItemsView
          initialView="feed"
          lockedView="feed"
          sortMode="publishedDesc"
          {...RSS_ITEMS_VIEW_PRESET}
          initialFilters={initialFilters}
          fixedSourceIds={selectedSourceIds}
          rssTranslationConfig={
            translationEnabled
              ? {
                  enabled: translationReady,
                  provider: translationProvider,
                  targetLanguage,
                  fields: ["title", "summary"]
                }
              : undefined
          }
          onTranslationError={setTranslationError}
        />
      ) : null}
    </Space>
  );
}
