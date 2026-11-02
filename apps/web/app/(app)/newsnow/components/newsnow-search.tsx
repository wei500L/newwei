"use client";

import { SearchOutlined, StarFilled, StarOutlined } from "@ant-design/icons";
import { Input, List, Modal, Spin, Tag } from "antd";
import { useState, useMemo } from "react";
import { useTranslation } from "react-i18next";

import { useNewsMetadata } from "../hooks/use-news-sources";
import { buildNewsnowSearchSources } from "../lib/newsnow-search";
import { useNewsnowStore } from "../store/newsnow-store";

interface NewsnowSearchProps {
  isOpen: boolean;
  onClose: () => void;
}

export function NewsnowSearch({ isOpen, onClose }: NewsnowSearchProps) {
  const { t } = useTranslation();
  const [searchText, setSearchText] = useState("");
  const { data: metadata, isLoading: metadataLoading, error: metadataError } = useNewsMetadata();
  const { focusSources, toggleFocus } = useNewsnowStore();

  const filteredSources = useMemo(
    () => buildNewsnowSearchSources(metadata, searchText),
    [metadata, searchText],
  );
  const normalizedSearchText = searchText.trim();
  const searchStatus = useMemo(() => {
    if (metadataError) {
      return {
        tone: "error" as const,
        message: t("search.feedback.error"),
      };
    }
    if (metadataLoading) {
      return {
        tone: "loading" as const,
        message: t("search.feedback.sourcesLoading"),
      };
    }
    if (!normalizedSearchText) {
      return {
        tone: "idle" as const,
        message: t("search.feedback.sourcesIdle"),
      };
    }
    if (filteredSources.length === 0) {
      return {
        tone: "empty" as const,
        message: t("search.feedback.sourcesEmpty"),
      };
    }
    return {
      tone: "ready" as const,
      message: t("search.feedback.sourcesReady", {
        count: filteredSources.length,
      }),
    };
  }, [filteredSources.length, metadataError, metadataLoading, normalizedSearchText, t]);
  const searchStatusVisualState = useMemo(() => {
    if (searchStatus.tone === "error") {
      return "error";
    }
    if (searchStatus.tone === "loading") {
      return "loading";
    }
    if (searchStatus.tone === "ready") {
      return "ready";
    }
    if (searchStatus.tone === "empty") {
      return "empty";
    }
    return "idle";
  }, [searchStatus.tone]);

  const colorMap: Record<string, string> = {
    slate: "default",
    blue: "blue",
    red: "red",
    green: "green",
    orange: "orange",
    gray: "default",
    indigo: "indigo",
    emerald: "green",
    teal: "cyan",
    yellow: "gold",
  };

  return (
    <Modal
      title={t("newsnow.search.title")}
      open={isOpen}
      onCancel={onClose}
      footer={null}
      width="min(620px, calc(100vw - 32px))"
      styles={{ body: { padding: "0 0 14px" } }}
    >
      <div>
        <div className="border-b border-[var(--border)] px-4 py-2">
          <Input
            placeholder={t("newsnow.search.placeholder")}
            prefix={<SearchOutlined />}
            allowClear
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
          />
          <div
            className={`mt-1.5 search-feedback-pill search-feedback-pill--${searchStatusVisualState}`}
            role="status"
            aria-live="polite"
          >
            <span className="search-feedback-pill__icon" aria-hidden>
              {searchStatus.tone === "loading" ? <Spin size="small" /> : <SearchOutlined />}
            </span>
            <span className="search-feedback-pill__text">{searchStatus.message}</span>
          </div>
        </div>
        <div className="max-h-viz-3xl overflow-y-auto px-4 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
          <List
            split={false}
            dataSource={filteredSources}
            renderItem={({ id, source, column }) => {
              const isFocused = focusSources.includes(id);
              return (
                <List.Item
                  role="button"
                  tabIndex={0}
                  aria-label={`${isFocused ? t("newsnow.search.unfocus") : t("newsnow.search.focus")} ${source.name}`}
                  className="!border-none cursor-pointer rounded-md px-2 py-2 transition-colors hover:bg-[var(--secondary)]"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") toggleFocus(id);
                  }}
                  onClick={() => toggleFocus(id)}
                >
                  <div className="flex w-full items-center justify-between">
                    <div className="flex flex-col">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-[var(--foreground)]">
                          {source.name}
                        </span>
                        <Tag
                          color={colorMap[source.color] || "blue"}
                          className="text-[10px]"
                        >
                          {column}
                        </Tag>
                      </div>
                      {source.title && (
                        <span className="text-xs text-[var(--muted-foreground)]">
                          {source.title}
                        </span>
                      )}
                    </div>
                    <div className="text-lg">
                      {isFocused ? (
                        <StarFilled className="text-[var(--accent)]" />
                      ) : (
                        <StarOutlined className="text-[var(--muted-foreground)]" />
                      )}
                    </div>
                  </div>
                </List.Item>
              );
            }}
            locale={{ emptyText: t("newsnow.search.empty") }}
          />
        </div>
      </div>
    </Modal>
  );
}
