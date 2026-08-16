export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const leanId = (value: unknown): string | null => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (value && typeof value === "object" && "toString" in value) {
    const text = String(Reflect.get(value, "toString") instanceof Function ? value.toString() : "");
    if (text && text !== "[object Object]") {
      return text;
    }
  }
  return null;
};

export const asLeanRecords = (value: unknown): Record<string, unknown>[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isRecord);
};
