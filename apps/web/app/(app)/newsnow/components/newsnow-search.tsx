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
      title="搜索新闻源"
      open={isOpen}
      onCancel={onClose}
      footer={null}
      width={620}
      className="[&_.ant-modal-close]:text-zinc-400 [&_.ant-modal-close:hover]:bg-white/10 [&_.ant-modal-close:hover]:text-zinc-100 [&_.ant-modal-title]:text-zinc-100"
      styles={{
        content: {
          background:
            "linear-gradient(180deg, rgba(10,14,22,0.98) 0%, rgba(7,11,18,0.98) 100%)",
          border: "1px solid rgba(255,255,255,0.09)",
          boxShadow: "0 28px 70px -42px rgba(0,0,0,0.95)",
        },
        header: {
          background: "transparent",
          borderBottom: "1px solid rgba(255,255,255,0.09)",
        },
        body: { padding: "0 0 14px" },
      }}
    >
      <div className="[&_.ant-input]:bg-transparent [&_.ant-input]:text-zinc-100 [&_.ant-input-affix-wrapper-focused]:border-blue-400/60 [&_.ant-input-affix-wrapper-focused]:shadow-none [&_.ant-input-affix-wrapper:hover]:border-white/20 [&_.ant-input-affix-wrapper]:border-white/10 [&_.ant-input-affix-wrapper]:bg-black/35 [&_.ant-input-clear-icon]:text-zinc-500 [&_.ant-input-prefix]:text-zinc-500 [&_.ant-list-empty-text]:text-zinc-500">
        <div className="border-b border-white/10 px-4 py-2">
          <Input
            placeholder="输入源名称或关键词..."
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
                  aria-label={`${isFocused ? "取消关注" : "关注"} ${source.name}`}
                  className="!border-none cursor-pointer rounded-md px-2 py-2 transition-colors hover:bg-white/10"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") toggleFocus(id);
                  }}
                  onClick={() => toggleFocus(id)}
                >
                  <div className="flex w-full items-center justify-between">
                    <div className="flex flex-col">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-zinc-100">
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
                        <span className="text-xs text-zinc-400">
                          {source.title}
                        </span>
                      )}
                    </div>
                    <div className="text-lg">
                      {isFocused ? (
                        <StarFilled className="text-yellow-500" />
                      ) : (
                        <StarOutlined className="text-zinc-500" />
                      )}
                    </div>
                  </div>
                </List.Item>
              );
            }}
            locale={{ emptyText: "没有找到匹配的源" }}
          />
        </div>
      </div>
    </Modal>
  );
}
