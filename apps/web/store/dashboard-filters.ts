import { createWithEqualityFn as create } from "zustand/traditional";

export const QUEUE_STATUS_KEYS = [
  "waiting",
  "active",
  "completed",
  "failed",
  "delayed"
] as const;

export type QueueStatusKey = (typeof QUEUE_STATUS_KEYS)[number];

interface DashboardFiltersState {
  queueStatus: QueueStatusKey | null;
  selectedSector: string | null;
  setQueueStatus: (status: QueueStatusKey | null) => void;
  clearQueueStatus: () => void;
  setSelectedSector: (sector: string | null) => void;
}

export const useDashboardFiltersStore = create<DashboardFiltersState>((set) => ({
  queueStatus: null,
  selectedSector: null,
  setQueueStatus: (queueStatus) => set({ queueStatus }),
  clearQueueStatus: () => set({ queueStatus: null }),
  setSelectedSector: (selectedSector) => set({ selectedSector })
}));
