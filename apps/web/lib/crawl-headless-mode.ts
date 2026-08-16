export type CrawlHeadlessMode = "auto" | "headless" | "headed";

export function resolveHeadlessModeFromHeadlessValue(
  value: unknown,
): CrawlHeadlessMode {
  if (value === true) {
    return "headless";
  }
  if (value === false) {
    return "headed";
  }
  return "auto";
}

export function applyHeadlessModeToCrawlOptions(
  options: Record<string, unknown>,
  headlessMode: unknown,
): void {
  const normalizedMode =
    typeof headlessMode === "string" ? headlessMode.trim().toLowerCase() : "";
  if (normalizedMode === "headless") {
    options.headless = true;
    return;
  }
  if (normalizedMode === "headed") {
    options.headless = false;
    return;
  }
  delete options.headless;
}

export function normalizeHeadlessModeFormValues<
  T extends {
    headlessMode?: unknown;
    headless?: boolean;
  },
>(values: T): T {
  const normalized = { ...values } as T;
  applyHeadlessModeToCrawlOptions(
    normalized as Record<string, unknown>,
    values.headlessMode,
  );
  delete (normalized as { headlessMode?: unknown }).headlessMode;
  return normalized;
}
