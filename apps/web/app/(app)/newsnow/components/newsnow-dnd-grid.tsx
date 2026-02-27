"use client";

import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import type { DragEndEvent } from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  rectSortingStrategy,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";

import { useIsMobile } from "../hooks/use-is-mobile";
import { type Source } from "../hooks/use-news-sources";
import {
  type PersonalizedSourceScoreDetail,
  useNewsnowPersonalizedOrder,
} from "../hooks/use-newsnow-personalized-order";
import {
  buildCrossSourceDedupResult,
  reorderNewsnowItems,
} from "../lib/newsnow-dnd";
import { useNewsnowStore } from "../store/newsnow-store";

import { NewsnowCard } from "./newsnow-card";

interface NewsnowDndGridProps {
  columnKey: string;
  sourceIds: string[];
  sourcesMap: Record<string, Source>;
}

function NewsnowDndGridContent({ columnKey, sourceIds, sourcesMap }: NewsnowDndGridProps) {
  const {
    columnOrders,
    setColumnOrder,
    sourceAffinity,
    sourceSnapshots,
    focusSources,
    sortMode,
    hideCrossSourceDuplicates,
    liveUnreadBySource,
  } = useNewsnowStore();
  const [items, setItems] = useState<string[]>([]);
  const isMobile = useIsMobile();

  useEffect(() => {
    const savedOrder = columnOrders[columnKey];
    if (savedOrder && savedOrder.length > 0) {
      // Filter out deleted sources or sources not in current list
      const filteredOrder = savedOrder.filter((id) => sourceIds.includes(id));
      // Add new sources to the end
      const newSources = sourceIds.filter((id) => !savedOrder.includes(id));
      setItems([...filteredOrder, ...newSources]);
    } else {
      setItems(sourceIds);
    }
  }, [columnKey, sourceIds, columnOrders]);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  function handleDragEnd(event: DragEndEvent) {
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
    const scopedSourceAffinity = items.reduce(
      (acc, sourceId) => {
        if (sourceAffinity[sourceId]) {
          acc[sourceId] = sourceAffinity[sourceId];
        }
        return acc;
      },
      {} as typeof sourceAffinity,
    );
    return {
      sortMode,
      focusSources,
      columnOrders: {
        [columnKey]: columnOrders[columnKey] ?? [],
      },
      sourceAffinity: scopedSourceAffinity,
    } as const;
  }, [columnKey, columnOrders, focusSources, items, sortMode, sourceAffinity]);

  const { data: personalizedOrder } = useNewsnowPersonalizedOrder({
    columnKey,
    sourceIds: items,
    settingsOverride: sortSettingsOverride,
    enabled: (sortMode === "personalized" || sortMode === "smart") && items.length > 0,
  });

  const effectiveDisplayItems = useMemo(() => {
    const hasManualOrder = (columnOrders[columnKey]?.length ?? 0) > 0;
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
  }, [columnKey, columnOrders, items, personalizedOrder?.sourceIds, sortMode]);
  const personalizedScoreDetailsBySourceId = useMemo(
    () =>
      (personalizedOrder?.sourceScoreDetails ?? {}) as Record<
        string,
        PersonalizedSourceScoreDetail
      >,
    [personalizedOrder?.sourceScoreDetails],
  );

  const dedupeResult = useMemo(
    () =>
      buildCrossSourceDedupResult({
        sourceOrder: effectiveDisplayItems,
        snapshots: sourceSnapshots,
      }),
    [effectiveDisplayItems, sourceSnapshots],
  );

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={handleDragEnd}
    >
      <div
        className={
          isMobile
            ? "flex flex-col gap-4"
            : "grid grid-cols-1 gap-5 md:grid-cols-[repeat(auto-fill,minmax(min(100%,340px),1fr))] md:gap-6 xl:gap-7"
        }
      >
        <SortableContext
          items={effectiveDisplayItems}
          strategy={isMobile ? verticalListSortingStrategy : rectSortingStrategy}
        >
          {effectiveDisplayItems.map((id) => (
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
                  realtimeUnreadCount={liveUnreadBySource[id] ?? 0}
                  personalizedScoreDetail={personalizedScoreDetailsBySourceId[id]}
                />
              ) : null}
            </div>
          ))}
        </SortableContext>
      </div>
    </DndContext>
  );
}

// Ensure DnD components only render on client
export const NewsnowDndGrid = dynamic(() => Promise.resolve(NewsnowDndGridContent), {
  ssr: false,
});
