export interface NewsSourceRuntimeSecretsConfig {
  description?: string;
  requiredAnyOfKeys?: string[];
  suggestedKeys?: string[];
  envFallbackKeys?: string[];
}

export interface NewsSourceMetadataLike {
  name?: string;
  runtimeSecrets?: NewsSourceRuntimeSecretsConfig;
}

export interface RuntimeSecretRowLike {
  rowKey: string;
  sourceId: string;
  key: string;
}

export interface PersistedRuntimeSecretRowLike extends RuntimeSecretRowLike {
  persisted?: boolean;
}

export type RuntimeSecretRequirementLevel = 'required' | 'optional' | 'none';

export interface RuntimeSecretSourceFilters {
  onlyConfigured?: boolean;
  onlyRequired?: boolean;
}

export interface RuntimeSecretSourceEntry<Meta extends NewsSourceMetadataLike = NewsSourceMetadataLike> {
  sourceId: string;
  metadata: Meta;
}

function normalizeSourceId(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeSearchQuery(value: string): string {
  return value.trim().toLowerCase();
}

function uniqueNormalizedKeys(values: string[] | undefined): string[] {
  if (!Array.isArray(values)) {
    return [];
  }
  return Array.from(
    new Set(values.map((value) => value.trim()).filter((value) => value.length > 0)),
  );
}

export function sourceSupportsRuntimeSecrets(
  source: NewsSourceMetadataLike | null | undefined,
): boolean {
  const config = source?.runtimeSecrets;
  if (!config) {
    return false;
  }
  return (
    uniqueNormalizedKeys(config.requiredAnyOfKeys).length > 0 ||
    uniqueNormalizedKeys(config.suggestedKeys).length > 0 ||
    uniqueNormalizedKeys(config.envFallbackKeys).length > 0
  );
}

export function sourceRequiresRuntimeSecrets(
  source: NewsSourceMetadataLike | null | undefined,
): boolean {
  return uniqueNormalizedKeys(source?.runtimeSecrets?.requiredAnyOfKeys).length > 0;
}

export function getRuntimeSecretRequirementLevel(
  source: NewsSourceMetadataLike | null | undefined,
): RuntimeSecretRequirementLevel {
  if (sourceRequiresRuntimeSecrets(source)) {
    return 'required';
  }
  if (sourceSupportsRuntimeSecrets(source)) {
    return 'optional';
  }
  return 'none';
}

export function getRuntimeSecretSuggestedKeys(
  config: NewsSourceRuntimeSecretsConfig | null | undefined,
): string[] {
  const required = uniqueNormalizedKeys(config?.requiredAnyOfKeys);
  const suggested = uniqueNormalizedKeys(config?.suggestedKeys);
  return Array.from(new Set([...required, ...suggested]));
}

export function getRuntimeSecretEnvFallbackKeys(
  config: NewsSourceRuntimeSecretsConfig | null | undefined,
): string[] {
  return uniqueNormalizedKeys(config?.envFallbackKeys);
}

export function getPrimaryRuntimeSecretKey(
  config: NewsSourceRuntimeSecretsConfig | null | undefined,
): string | undefined {
  return getRuntimeSecretSuggestedKeys(config)[0];
}

export function findExistingRuntimeSecretRow<Row extends RuntimeSecretRowLike>(
  rows: Row[],
  sourceId: string,
  secretKey?: string,
): Row | null {
  const normalizedSourceId = normalizeSourceId(sourceId);
  const normalizedSecretKey = secretKey?.trim() ?? '';
  if (!normalizedSourceId) {
    return null;
  }

  if (normalizedSecretKey) {
    const exactMatch = rows.find(
      (row) =>
        row.sourceId.trim().toLowerCase() === normalizedSourceId &&
        row.key.trim() === normalizedSecretKey,
    );
    if (exactMatch) {
      return exactMatch;
    }
  }

  return (
    rows.find((row) => normalizeSourceId(row.sourceId) === normalizedSourceId) ?? null
  );
}

export function listConfiguredRuntimeSecretSourceIds<
  Row extends PersistedRuntimeSecretRowLike,
>(rows: Row[]): string[] {
  return Array.from(
    new Set(
      rows
        .filter((row) => row.persisted !== false)
        .map((row) => normalizeSourceId(row.sourceId))
        .filter((sourceId) => sourceId.length > 0),
    ),
  );
}

export function filterRuntimeSecretSources<
  Meta extends NewsSourceMetadataLike,
  Row extends PersistedRuntimeSecretRowLike,
>( 
  entries: Array<RuntimeSecretSourceEntry<Meta>>,
  rows: Row[],
  filters: RuntimeSecretSourceFilters,
): Array<RuntimeSecretSourceEntry<Meta>> {
  const configuredSourceIds = new Set(listConfiguredRuntimeSecretSourceIds(rows));

  return entries.filter(({ sourceId, metadata }) => {
    if (!sourceSupportsRuntimeSecrets(metadata)) {
      return false;
    }

    if (filters.onlyConfigured && !configuredSourceIds.has(normalizeSourceId(sourceId))) {
      return false;
    }

    if (filters.onlyRequired && getRuntimeSecretRequirementLevel(metadata) !== 'required') {
      return false;
    }

    return true;
  });
}

export function matchesRuntimeSecretSourceQuery<
  Meta extends NewsSourceMetadataLike,
>(entry: RuntimeSecretSourceEntry<Meta>, query: string): boolean {
  const normalizedQuery = normalizeSearchQuery(query);
  if (!normalizedQuery) {
    return true;
  }

  const fields = [
    entry.sourceId,
    entry.metadata.name,
    ...getRuntimeSecretSuggestedKeys(entry.metadata.runtimeSecrets),
    ...getRuntimeSecretEnvFallbackKeys(entry.metadata.runtimeSecrets),
  ];

  return fields.some(
    (field) => typeof field === 'string' && field.toLowerCase().includes(normalizedQuery),
  );
}

export function matchesRuntimeSecretRowQuery<
  Meta extends NewsSourceMetadataLike,
  Row extends PersistedRuntimeSecretRowLike,
>(row: Row, metadata: Meta | null | undefined, query: string): boolean {
  const normalizedQuery = normalizeSearchQuery(query);
  if (!normalizedQuery) {
    return true;
  }

  const fields = [
    row.sourceId,
    row.key,
    metadata?.name,
    ...getRuntimeSecretSuggestedKeys(metadata?.runtimeSecrets),
  ];

  return fields.some(
    (field) => typeof field === 'string' && field.toLowerCase().includes(normalizedQuery),
  );
}
