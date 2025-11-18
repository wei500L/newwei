import { create } from "zustand";
import { nanoid } from "nanoid";

export type DashboardWidgetType = "line" | "bar" | "pie" | "scatter" | "kline" | "radar" | "table";

export interface DashboardWidgetState {
  id: string;
  title?: string;
  type: DashboardWidgetType;
  dataSource: string;
  dataConfig?: Record<string, unknown>;
  layout: { x: number; y: number; w: number; h: number };
  sortOrder: number;
  options?: Record<string, unknown>;
}

export interface DashboardEditorState {
  widgets: DashboardWidgetState[];
  theme: "light" | "dark";
  name: string;
  slug: string;
  description?: string;
  primaryColor?: string;
  setMeta: (meta: { name?: string; slug?: string; description?: string; theme?: "light" | "dark"; primaryColor?: string }) => void;
  setTheme: (theme: "light" | "dark") => void;
  setWidgets: (widgets: DashboardWidgetState[]) => void;
  addWidget: (widget: Omit<DashboardWidgetState, "id" | "sortOrder">) => void;
  updateWidget: (id: string, patch: Partial<DashboardWidgetState>) => void;
  updateLayout: (layouts: { i: string; x: number; y: number; w: number; h: number }[]) => void;
  removeWidget: (id: string) => void;
  reset: () => void;
}

export const useDashboardEditorStore = create<DashboardEditorState>((set, get) => ({
  widgets: [],
  theme: "light",
  name: "Analysis Dashboard",
  slug: `analysis-${nanoid(6)}`,
  description: undefined,
  primaryColor: "#1677ff",
  setMeta: (meta) =>
    set((state) => ({
      name: meta.name ?? state.name,
      slug: meta.slug ?? state.slug,
      description: meta.description ?? state.description,
      theme: (meta.theme as "light" | "dark" | undefined) ?? state.theme,
      primaryColor: meta.primaryColor ?? state.primaryColor
    })),
  setTheme: (theme) => set({ theme }),
  setWidgets: (widgets) => set({ widgets }),
  addWidget: (widget) =>
    set((state) => ({
      widgets: [
        ...state.widgets,
        {
          ...widget,
          id: `temp-${nanoid()}`,
          sortOrder: state.widgets.length
        }
      ]
    })),
  updateWidget: (id, patch) =>
    set((state) => ({
      widgets: state.widgets.map((widget) => (widget.id === id ? { ...widget, ...patch } : widget))
    })),
  updateLayout: (layouts) => {
    const layoutMap = new Map(layouts.map((entry) => [entry.i, entry]));
    set((state) => ({
      widgets: state.widgets.map((widget) => {
        const next = layoutMap.get(widget.id);
        if (!next) {
          return widget;
        }
        return {
          ...widget,
          layout: { x: next.x, y: next.y, w: next.w, h: next.h }
        };
      })
    }));
  },
  removeWidget: (id) => set((state) => ({ widgets: state.widgets.filter((widget) => widget.id !== id) })),
  reset: () =>
    set({
      widgets: [],
      theme: "light",
      name: "Analysis Dashboard",
      slug: `analysis-${nanoid(6)}`,
      description: undefined,
      primaryColor: "#1677ff"
    })
}));
