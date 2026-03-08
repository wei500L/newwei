import { NEWS_SOURCE_RUNTIME_SECRET_REQUIRED_CODE } from './api-error';
import {
  findExistingRuntimeSecretRow,
  getPrimaryRuntimeSecretKey,
  sourceSupportsRuntimeSecrets,
  type NewsSourceMetadataLike,
  type RuntimeSecretRowLike,
} from './news-source-runtime-secrets';

function normalizeSourceId(value: string): string {
  return value.trim().toLowerCase();
}

function appendUniqueSourceId(sourceIds: string[], nextSourceId: string): string[] {
  if (sourceIds.includes(nextSourceId)) {
    return sourceIds;
  }
  return [...sourceIds, nextSourceId];
}

export type RuntimeSecretDeepLinkAction<Row extends RuntimeSecretRowLike = RuntimeSecretRowLike> =
  | { type: 'pending' }
  | { type: 'ignore' }
  | { type: 'focus'; row: Row }
  | { type: 'create'; sourceId: string; secretKey?: string };

export function resolveRuntimeSecretDeepLinkAction<
  Meta extends NewsSourceMetadataLike,
  Row extends RuntimeSecretRowLike,
>(
  rows: Row[],
  sourceCatalog: Record<string, Meta>,
  deepLinkedSourceId: string,
): RuntimeSecretDeepLinkAction<Row> {
  const existingRow = findExistingRuntimeSecretRow(rows, deepLinkedSourceId);
  if (existingRow) {
    return { type: 'focus', row: existingRow };
  }

  const sourceMetadata = sourceCatalog[normalizeSourceId(deepLinkedSourceId)];
  if (!sourceMetadata) {
    return { type: 'pending' };
  }
  if (!sourceSupportsRuntimeSecrets(sourceMetadata)) {
    return { type: 'ignore' };
  }

  return {
    type: 'create',
    sourceId: deepLinkedSourceId,
    secretKey: getPrimaryRuntimeSecretKey(sourceMetadata.runtimeSecrets),
  };
}

export interface ResolveExpandedRuntimeSecretSourceIdsOptions {
  currentExpandedSourceIds: string[];
  visibleSourceIds: string[];
  sourceQuery: string;
  hasInitialized: boolean;
}

export interface ResolveExpandedRuntimeSecretSourceIdsResult {
  nextExpandedSourceIds: string[];
  hasInitialized: boolean;
}

export function resolveExpandedRuntimeSecretSourceIds(
  options: ResolveExpandedRuntimeSecretSourceIdsOptions,
): ResolveExpandedRuntimeSecretSourceIdsResult {
  const { currentExpandedSourceIds, visibleSourceIds, sourceQuery, hasInitialized } = options;
  const keptSourceIds = currentExpandedSourceIds.filter((sourceId) => visibleSourceIds.includes(sourceId));
  const normalizedSourceQuery = normalizeSourceId(sourceQuery);

  if (!hasInitialized) {
    if (visibleSourceIds.length === 0) {
      return {
        nextExpandedSourceIds: currentExpandedSourceIds,
        hasInitialized,
      };
    }

    return {
      nextExpandedSourceIds:
        normalizedSourceQuery && visibleSourceIds.includes(normalizedSourceQuery)
          ? appendUniqueSourceId(visibleSourceIds, normalizedSourceQuery)
          : visibleSourceIds,
      hasInitialized: true,
    };
  }

  if (normalizedSourceQuery && visibleSourceIds.includes(normalizedSourceQuery)) {
    return {
      nextExpandedSourceIds: appendUniqueSourceId(keptSourceIds, normalizedSourceQuery),
      hasInitialized,
    };
  }

  if (keptSourceIds.length === 0 && currentExpandedSourceIds.length > 0) {
    return {
      nextExpandedSourceIds: visibleSourceIds,
      hasInitialized,
    };
  }

  return {
    nextExpandedSourceIds: keptSourceIds,
    hasInitialized,
  };
}

export function shouldShowRuntimeSecretCta(
  source: NewsSourceMetadataLike | null | undefined,
  errorCode?: string | null,
): boolean {
  return errorCode === NEWS_SOURCE_RUNTIME_SECRET_REQUIRED_CODE || sourceSupportsRuntimeSecrets(source);
}
