export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const asRecord = (value: unknown): Record<string, unknown> =>
  isRecord(value) ? value : {};

export const readObjectKey = (value: unknown, key: string): unknown =>
  isRecord(value) ? value[key] : undefined;

export const narrowUnknown = <T>(value: unknown): T => value as T;
