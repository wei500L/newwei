import type { ArchivePreparationState } from './archive.types';

export type ArchivePreparationScope = 'digest' | 'calendar';

export interface ArchivePreparationJobPayload {
  scope: ArchivePreparationScope;
  orgId: string;
  anchorDate?: string;
  month?: string;
  traceId?: string;
}

export interface ArchivePreparationStatusRecord {
  scope: ArchivePreparationScope;
  scopeValue: string;
  state: ArchivePreparationState;
  updatedAt: string;
  errorMessage?: string | null;
}

export interface ArchivePreparationOperationalStatus {
  updatedAt: string;
  pending: number;
  counts: {
    waiting: number;
    active: number;
    completed: number;
    failed: number;
    delayed: number;
  };
  recentStatuses: ArchivePreparationStatusRecord[];
}
