import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

interface NewsnowState {
  focusSources: string[];
  columnOrders: Record<string, string[]>;
  toggleFocus: (id: string) => void;
  setColumnOrder: (column: string, order: string[]) => void;
}

export const useNewsnowStore = create<NewsnowState>()(
  persist(
    (set) => ({
      focusSources: [],
      columnOrders: {},
      toggleFocus: (id) =>
        set((state) => ({
          focusSources: state.focusSources.includes(id)
            ? state.focusSources.filter((s) => s !== id)
            : [...state.focusSources, id],
        })),
      setColumnOrder: (column, order) =>
        set((state) => ({
          columnOrders: {
            ...state.columnOrders,
            [column]: order,
          },
        })),
    }),
    {
      name: "newsnow-storage",
      storage: createJSONStorage(() => localStorage),
    }
  )
);
