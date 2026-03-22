"use client";

import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import type {
  DragEndEvent,
  DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  rectSortingStrategy,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { useWindowVirtualizer } from "@tanstack/react-virtual";
import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import { shallow } from "zustand/shallow";

import { useIsMobile } from "../hooks/use-is-mobile";
import { type NewsnowAnalyzedItem, type Source } from "../hooks/use-news-sources";
import {
  type PersonalizedSourceScoreDetail,
  useNewsnowPersonalizedOrder,
} from "../hooks/use-newsnow-personalized-order";
import { useSharedNowTick } from "../hooks/use-shared-now-tick";
import {
  type CrossSourceDedupCache,
  buildCrossSourceDedupResult,
  reorderNewsnowItems,
} from "../lib/newsnow-dnd";
import { useNewsnowStore } from "../store/newsnow-store";

import { NewsnowCard } from "./newsnow-card";

interface NewsnowDndGridProps {
  columnKey: string;
  sourceIds: string[];
  sourcesMap: Record<string, Source>;
  analysisBySource?: Record<string, Record<string, NewsnowAnalyzedItem>>;
}

const DESKTOP_MIN_CARD_WIDTH = 340;
const DESKTOP_GRID_GAP_PX = 24;
const MOBILE_GRID_GAP_PX = 16;
const VIRTUAL_ROW_ESTIMATE_PX = 520;
const EMPTY_SOURCE_IDS: string[] = [];

function NewsnowDndGridContent({
  columnKey,
  sourceIds,
  sourcesMap,
  analysisBySource,
}: NewsnowDndGridProps) {
  const columnOrder = useNewsnowStore(
    (state) => state.columnOrders[columnKey] ?? EMPTY_SOURCE_IDS,
  );
  const setColumnOrder = useNewsnowStore((state) => state.setColumnOrder);
  const focusSources = useNewsnowStore((state) => state.focusSources);
  const sortMode = useNewsnowStore((state) => state.sortMode);
  const hideCrossSourceDuplicates = useNewsnowStore(
    (state) => state.hideCrossSourceDuplicates,
  );
  const [items, setItems] = useState<string[]>([]);
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [gridWidth, setGridWidth] = useState(0);
  const [scrollMargin, setScrollMargin] = useState(0);
  const isMobile = useIsMobile();
  const nowMs = useSharedNowTick();
  const dedupeCacheRef = useRef<CrossSourceDedupCache | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (columnOrder.length > 0) {
      // Filter out deleted sources or sources not in current list
      const filteredOrder = columnOrder.filter((id) => sourceIds.includes(id));
      // Add new sources to the end
      const newSources = sourceIds.filter((id) => !columnOrder.includes(id));
      setItems([...filteredOrder, ...newSources]);
    } else {
      setItems(sourceIds);
    }
  }, [columnOrder, sourceIds]);
  const scopedSourceAffinity = useNewsnowStore(
    (state) => {
      const next: typeof state.sourceAffinity = {};
      for (const sourceId of items) {
        const affinity = state.sourceAffinity[sourceId];
        if (affinity) {
          next[sourceId] = affinity;
        }
      }
      return next;
    },
    shallow,
  );

  useEffect(() => {
    const node = gridRef.current;
    if (!node) {
      return;
    }

    const updateMetrics = () => {
      setGridWidth(node.clientWidth);
      setScrollMargin(node.getBoundingClientRect().top + window.scrollY);
    };

    updateMetrics();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateMetrics);
      return () => {
        window.removeEventListener("resize", updateMetrics);
      };
    }

    const observer = new ResizeObserver(() => {
      updateMetrics();
    });
    observer.observe(node);
    window.addEventListener("resize", updateMetrics);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateMetrics);
    };
  }, []);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 4,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  function handleDragStart(event: DragStartEvent) {
    if (sortMode === "personalized" || isMobile || sortMode === "smart") {
      return;
    }
    setActiveDragId(String(event.active.id));
  }

  function handleDragCancel() {
    setActiveDragId(null);
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveDragId(null);
    if (sortMode === "personalized" || isMobile || sortMode === "smart") {
      return;
    }
    const { active, over } = event;
    const activeId = String(active.id);
    const overId = over?.id ? String(over.id) : null;

    setItems((items) => {
      const newOrder = reorderNewsnowItems(items, activeId, overId);
      if (newOrder === items) {
        return items;
      }

      if (activeId !== overId) {
        setColumnOrder(columnKey, newOrder);
      }
      return newOrder;
    });
  }

  const sortSettingsOverride = useMemo(() => {
    if (sortMode !== "personalized" && sortMode !== "smart") {
      return undefined;
    }
    return {
      sortMode,
      focusSources,
      columnOrders: {
        [columnKey]: columnOrder,
      },
      sourceAffinity: scopedSourceAffinity,
    } as const;
  }, [columnKey, columnOrder, focusSources, scopedSourceAffinity, sortMode]);

  const { data: personalizedOrder } = useNewsnowPersonalizedOrder({
    columnKey,
    sourceIds: items,
    settingsOverride: sortSettingsOverride,
    enabled: (sortMode === "personalized" || sortMode === "smart") && items.length > 0,
  });

  const effectiveDisplayItems = useMemo(() => {
    const hasManualOrder = columnOrder.length > 0;
    if (sortMode !== "personalized" && sortMode !== "smart") {
      return items;
    }
    // priority: manual order > personalized response > global metadata/default order
    if (hasManualOrder) {
      return items;
    }
    if (personalizedOrder?.sourceIds && personalizedOrder.sourceIds.length > 0) {
      return personalizedOrder.sourceIds;
    }
    return items;
  }, [columnOrder.length, items, personalizedOrder?.sourceIds, sortMode]);
  const personalizedScoreDetailsBySourceId = useMemo(
    () =>
      (personalizedOrder?.sourceScoreDetails ?? {}) as Record<
        string,
        PersonalizedSourceScoreDetail
      >,
    [personalizedOrder?.sourceScoreDetails],
  );
  const scopedSourceSnapshots = useNewsnowStore(
    (state) => {
      const next: typeof state.sourceSnapshots = {};
      for (const sourceId of effectiveDisplayItems) {
        const snapshot = state.sourceSnapshots[sourceId];
        if (snapshot) {
          next[sourceId] = snapshot;
        }
      }
      return next;
    },
    shallow,
  );
  const scopedSourceSnapshotHashes = useNewsnowStore(
    (state) => {
      const next: Record<string, string> = {};
      for (const sourceId of effectiveDisplayItems) {
        const hash = state.sourceSnapshotHashes[sourceId];
        if (hash) {
          next[sourceId] = hash;
        }
      }
      return next;
    },
    shallow,
  );

  const dedupeResult = useMemo(
    () => {
      const nextCache = buildCrossSourceDedupResult({
        sourceOrder: effectiveDisplayItems,
        snapshots: scopedSourceSnapshots,
        snapshotHashes: scopedSourceSnapshotHashes,
        previousCache: dedupeCacheRef.current,
      });
      dedupeCacheRef.current = nextCache;
      return nextCache;
    },
    [effectiveDisplayItems, scopedSourceSnapshotHashes, scopedSourceSnapshots],
  );
  const columnCount = useMemo(() => {
    if (isMobile) {
      return 1;
    }
    const safeWidth = Math.max(1, gridWidth);
    return Math.max(
      1,
      Math.floor(
        (safeWidth + DESKTOP_GRID_GAP_PX) /
          (DESKTOP_MIN_CARD_WIDTH + DESKTOP_GRID_GAP_PX),
      ),
    );
  }, [gridWidth, isMobile]);
  const rowGap = isMobile ? MOBILE_GRID_GAP_PX : DESKTOP_GRID_GAP_PX;
  const rowGroups = useMemo(() => {
    const groups: string[][] = [];
    for (let index = 0; index < effectiveDisplayItems.length; index += columnCount) {
      groups.push(effectiveDisplayItems.slice(index, index + columnCount));
    }
    return groups;
  }, [columnCount, effectiveDisplayItems]);
  const shouldVirtualize = !activeDragId && rowGroups.length > 4;
  const rowVirtualizer = useWindowVirtualizer({
    count: rowGroups.length,
    estimateSize: () => VIRTUAL_ROW_ESTIMATE_PX,
    overscan: 2,
    scrollMargin,
  });
  const virtualRows = shouldVirtualize
    ? rowVirtualizer.getVirtualItems()
    : rowGroups.map((row, index) => ({
        index,
        key: row.join("|") || `row-${index}`,
        size: VIRTUAL_ROW_ESTIMATE_PX,
        start: index * VIRTUAL_ROW_ESTIMATE_PX,
      }));

  const renderCard = (id: string) => (
    <div key={id}>
      {sourcesMap[id] ? (
        <NewsnowCard
          id={id}
          source={sourcesMap[id]}
          dragDisabled={
            sortMode === "personalized" || sortMode === "smart" || isMobile
          }
          mobileMode={isMobile}
          hideCrossSourceDuplicates={hideCrossSourceDuplicates}
          crossSourceMetaByItemId={dedupeResult.bySource[id]}
          duplicateItemsCount={dedupeResult.duplicateItemsBySource[id] ?? 0}
          visibleItemsCount={dedupeResult.visibleItemsBySource[id] ?? 0}
          personalizedScoreDetail={personalizedScoreDetailsBySourceId[id]}
          analysisByItemId={analysisBySource?.[id]}
          activeDragId={activeDragId}
          nowMs={nowMs}
        />
      ) : null}
    </div>
  );
  const rowGridClassName = isMobile ? "flex flex-col gap-4" : "grid";
  const rowGridStyle = isMobile
    ? undefined
    : {
        gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))`,
        gap: `${rowGap}px`,
      };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragCancel={handleDragCancel}
      onDragEnd={handleDragEnd}
    >
      <div ref={gridRef}>
        <SortableContext
          items={effectiveDisplayItems}
          strategy={isMobile ? verticalListSortingStrategy : rectSortingStrategy}
        >
          {shouldVirtualize ? (
            <div
              style={{
                height: `${rowVirtualizer.getTotalSize()}px`,
                position: "relative",
                width: "100%",
              }}
            >
              {virtualRows.map((virtualRow) => {
                const rowSourceIds = rowGroups[virtualRow.index] ?? [];
                return (
                  <div
                    key={virtualRow.key}
                    data-index={virtualRow.index}
                    ref={rowVirtualizer.measureElement}
                    style={{
                      left: 0,
                      position: "absolute",
                      top: 0,
                      transform: `translateY(${virtualRow.start - scrollMargin}px)`,
                      width: "100%",
                    }}
                  >
                    <div className={rowGridClassName} style={rowGridStyle}>
                      {rowSourceIds.map(renderCard)}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className={rowGridClassName} style={rowGridStyle}>
              {effectiveDisplayItems.map(renderCard)}
            </div>
          )}
        </SortableContext>
      </div>
    </DndContext>
  );
}

// Ensure DnD components only render on client
export const NewsnowDndGrid = dynamic(() => Promise.resolve(NewsnowDndGridContent), {
  ssr: false,
});
