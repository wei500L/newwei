"use client";

import { useMemo } from "react";

import type { NewsnowAnalyzedItem, Source } from "../hooks/use-news-sources";

import { NewsnowDndGrid } from "./newsnow-dnd-grid";

interface NewsnowColumnProps {
  columnKey: string;
  sourceIds: string[];
  sources: Record<string, Source>;
  analysisBySource?: Record<string, Record<string, NewsnowAnalyzedItem>>;
}

export function NewsnowColumn({
  columnKey,
  sourceIds,
  sources,
  analysisBySource,
}: NewsnowColumnProps) {
  const sourcesMap = useMemo(() => {
    const map: Record<string, Source> = {};
    sourceIds.forEach((id) => {
      if (sources[id]) {
        map[id] = sources[id];
      }
    });
    return map;
  }, [sourceIds, sources]);

  return (
    <div className="mx-auto w-full max-w-[1760px] px-4 pb-8 pt-6 md:px-6 md:pb-9 md:pt-7 xl:px-8">
      <NewsnowDndGrid
        columnKey={columnKey}
        sourceIds={sourceIds}
        sourcesMap={sourcesMap}
        analysisBySource={analysisBySource}
      />
    </div>
  );
}
