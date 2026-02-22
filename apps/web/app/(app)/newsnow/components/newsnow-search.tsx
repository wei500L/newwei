"use client";

import { SearchOutlined, StarFilled, StarOutlined } from "@ant-design/icons";
import { Modal, Input, List, Tag } from "antd";
import { useState, useMemo } from "react";

import { useNewsMetadata } from "../hooks/use-news-sources";
import { buildNewsnowSearchSources } from "../lib/newsnow-search";
import { useNewsnowStore } from "../store/newsnow-store";

interface NewsnowSearchProps {
  isOpen: boolean;
  onClose: () => void;
}

export function NewsnowSearch({ isOpen, onClose }: NewsnowSearchProps) {
  const [searchText, setSearchText] = useState("");
  const { data: metadata } = useNewsMetadata();
  const { focusSources, toggleFocus } = useNewsnowStore();

  const filteredSources = useMemo(
    () => buildNewsnowSearchSources(metadata, searchText),
    [metadata, searchText]
  );

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
      width={600}
      styles={{ body: { padding: "0 0 20px" } }}
    >
      <div className="px-4 py-2 border-b">
        <Input
          placeholder="输入源名称或关键词..."
          prefix={<SearchOutlined />}
          allowClear
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          className="rounded-md"
        />
      </div>
      <div className="max-h-[500px] overflow-y-auto px-4">
        <List
          dataSource={filteredSources}
          renderItem={({ id, source, column }) => {
            const isFocused = focusSources.includes(id);
            return (
              <List.Item
                role="button"
                tabIndex={0}
                aria-label={`${isFocused ? "取消关注" : "关注"} ${source.name}`}
                className="cursor-pointer transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-800"
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") toggleFocus(id); }}
                onClick={() => toggleFocus(id)}
              >
                <div className="flex w-full items-center justify-between">
                  <div className="flex flex-col">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-zinc-800 dark:text-zinc-200">{source.name}</span>
                      <Tag color={colorMap[source.color] || "blue"} className="text-[10px]">
                        {column}
                      </Tag>
                    </div>
                    {source.title && (
                      <span className="text-xs text-zinc-400">{source.title}</span>
                    )}
                  </div>
                  <div className="text-xl">
                    {isFocused ? (
                      <StarFilled className="text-yellow-500" />
                    ) : (
                      <StarOutlined className="text-zinc-300" />
                    )}
                  </div>
                </div>
              </List.Item>
            );
          }}
          locale={{ emptyText: "没有找到匹配的源" }}
        />
      </div>
    </Modal>
  );
}
