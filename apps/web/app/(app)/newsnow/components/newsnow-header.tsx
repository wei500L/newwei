"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Button } from "antd";
import { SearchOutlined } from "@ant-design/icons";
import { useNewsMetadata } from "../hooks/use-news-sources";
import { useState } from "react";
import { NewsnowSearch } from "./newsnow-search";

export function NewsnowHeader() {
  const pathname = usePathname();
  const { data: metadata } = useNewsMetadata();
  const [isSearchOpen, setIsSearchOpen] = useState(false);

  const staticTabs = [
    { key: "focus", name: "关注" },
    { key: "hottest", name: "最热" },
    { key: "realtime", name: "实时" },
  ];

  const dynamicTabs = metadata
    ? Object.entries(metadata.columns)
        .filter(([key]) => !["focus", "hottest", "realtime"].includes(key))
        .map(([key, column]) => ({ key, name: column.name }))
    : [];

  const allTabs = [...staticTabs, ...dynamicTabs];

  return (
    <header className="sticky top-0 z-50 w-full border-b bg-white/80 backdrop-blur-md dark:bg-zinc-900/80">
      <div className="mx-auto flex h-14 max-w-7xl items-center px-4">
        <nav className="flex h-full flex-1 items-center space-x-1 overflow-x-auto scrollbar-hide">
          {allTabs.map((tab) => {
            const href = `/newsnow/${tab.key}`;
            const isActive = pathname === href;
            return (
              <Link
                key={tab.key}
                href={href}
                aria-current={isActive ? "page" : undefined}
                className={`whitespace-nowrap px-4 py-2 text-sm font-medium transition-colors hover:text-blue-600 ${
                  isActive ? "border-b-2 border-blue-600 text-blue-600" : "text-zinc-600 dark:text-zinc-400"
                }`}
              >
                {tab.name}
              </Link>
            );
          })}
        </nav>
        <div className="ml-4 flex items-center">
          <Button
            type="text"
            icon={<SearchOutlined />}
            onClick={() => setIsSearchOpen(true)}
            className="flex items-center dark:text-zinc-400"
          >
            搜索
          </Button>
        </div>
      </div>
      <NewsnowSearch isOpen={isSearchOpen} onClose={() => setIsSearchOpen(false)} />
    </header>
  );
}
