"use client";

import { useMemo } from "react";

import type { NewsnowAnalyzedItem, Source } from "../hooks/use-news-sources";

import { NewsnowBoardContainer } from "./newsnow-board-container";
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
    <NewsnowBoardContainer spacing="content">
      <NewsnowDndGrid
        columnKey={columnKey}
        sourceIds={sourceIds}
        sourcesMap={sourcesMap}
        analysisBySource={analysisBySource}
      />
    </NewsnowBoardContainer>
  );
}
