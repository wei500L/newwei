export function normalizeProcessedResult(value: unknown): unknown {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (typeof parsed === "string") {
        return normalizeProcessedResult(parsed);
      }
      return parsed;
    } catch {
      return null;
    }
  }
  return value;
}

