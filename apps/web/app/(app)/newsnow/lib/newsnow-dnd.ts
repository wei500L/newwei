import { arrayMove } from "@dnd-kit/sortable";

export function reorderNewsnowItems(items: string[], activeId: string, overId?: string | null): string[] {
  if (!overId || activeId === overId) {
    return items;
  }

  const oldIndex = items.indexOf(activeId);
  const newIndex = items.indexOf(overId);

  if (oldIndex < 0 || newIndex < 0) {
    return items;
  }

  return arrayMove(items, oldIndex, newIndex);
}
