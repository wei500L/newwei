"use client";

import { useMemo } from "react";
import { Source } from "../hooks/use-news-sources";
import { NewsnowDndGrid } from "./newsnow-dnd-grid";

interface NewsnowColumnProps {
  columnKey: string;
  sourceIds: string[];
  sources: Record<string, Source>;
}

export function NewsnowColumn({ columnKey, sourceIds, sources }: NewsnowColumnProps) {
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
    <div className="mx-auto w-full max-w-[1880px] px-3 py-4 md:px-4 md:py-5">
      <NewsnowDndGrid columnKey={columnKey} sourceIds={sourceIds} sourcesMap={sourcesMap} />
    </div>
  );
}
