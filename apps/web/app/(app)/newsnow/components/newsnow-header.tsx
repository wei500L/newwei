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
    <header className="sticky top-0 z-50 w-full border-b border-white/10 bg-[linear-gradient(180deg,rgba(7,10,17,0.96)_0%,rgba(6,9,15,0.94)_100%)] shadow-[0_8px_24px_-18px_rgba(0,0,0,0.9)] backdrop-blur-md">
      <div className="mx-auto flex h-12 w-full items-center px-3 md:px-4">
        <nav className="flex h-full flex-1 items-center gap-1.5 overflow-x-auto [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
          {allTabs.map((tab) => {
            const href = `/newsnow/${tab.key}`;
            const isActive = pathname === href;
            return (
              <Link
                key={tab.key}
                href={href}
                aria-current={isActive ? "page" : undefined}
                className={`whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium tracking-[0.01em] transition-all ${
                  isActive
                    ? "bg-white/12 text-zinc-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.2)] ring-1 ring-white/20"
                    : "text-zinc-400 hover:bg-white/6 hover:text-zinc-100"
                }`}
              >
                {tab.name}
              </Link>
            );
          })}
        </nav>
        <div className="ml-3 flex items-center border-l border-white/10 pl-3">
          <Button
            type="text"
            icon={<SearchOutlined />}
            onClick={() => setIsSearchOpen(true)}
            className="flex items-center rounded-md text-zinc-400 hover:bg-white/6 hover:text-zinc-100"
          >
            搜索
          </Button>
        </div>
      </div>
      <NewsnowSearch
        isOpen={isSearchOpen}
        onClose={() => setIsSearchOpen(false)}
      />
    </header>
  );
}
