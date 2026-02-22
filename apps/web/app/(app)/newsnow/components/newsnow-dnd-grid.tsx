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
} from "@dnd-kit/sortable";
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";

import { type Source } from "../hooks/use-news-sources";
import { reorderNewsnowItems } from "../lib/newsnow-dnd";
import { useNewsnowStore } from "../store/newsnow-store";
import { NewsnowCard } from "./newsnow-card";

interface NewsnowDndGridProps {
  columnKey: string;
  sourceIds: string[];
  sourcesMap: Record<string, Source>;
}

function NewsnowDndGridContent({ columnKey, sourceIds, sourcesMap }: NewsnowDndGridProps) {
  const { columnOrders, setColumnOrder } = useNewsnowStore();
  const [items, setItems] = useState<string[]>([]);

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

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={handleDragEnd}
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
        <SortableContext items={items} strategy={rectSortingStrategy}>
          {items.map((id) => (
            <div key={id}>
              {sourcesMap[id] ? (
                <NewsnowCard id={id} source={sourcesMap[id]} />
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
