import { BadRequestException } from "@nestjs/common";

const DISALLOWED_NORMALIZED_KEYS = new Set(["extractionstrategy", "llmconfig"]);

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isDisallowedStrategyType(path: string, value: string): boolean {
  const normalizedPath = normalizeKey(path);
  const normalizedValue = normalizeKey(value);
  if (!normalizedValue.includes("llm")) {
    return false;
  }
  return normalizedPath.includes("strategy") || normalizedPath.includes("extraction");
}

function findDisallowedKeys(value: unknown, prefix = "", seen = new Set<unknown>()): string[] {
  if (!value || typeof value !== "object") {
    return [];
  }
  if (seen.has(value)) {
    return [];
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => findDisallowedKeys(entry, `${prefix}[${index}]`, seen));
  }

  const record = value as Record<string, unknown>;
  const hits: string[] = [];
  for (const [key, entry] of Object.entries(record)) {
    const normalized = normalizeKey(key);
    const path = prefix ? `${prefix}.${key}` : key;
    if (DISALLOWED_NORMALIZED_KEYS.has(normalized)) {
      hits.push(path);
    }
    if (normalized === "type" && typeof entry === "string" && isDisallowedStrategyType(path, entry)) {
      hits.push(path);
    }
    if (isPlainObject(entry) || Array.isArray(entry)) {
      hits.push(...findDisallowedKeys(entry, path, seen));
    }
  }
  return hits;
}

export function assertNoCrawl4aiLlmOptions(options: unknown, label = "crawlOptions") {
  const blocked = findDisallowedKeys(options);
  if (blocked.length === 0) {
    return;
  }
  const keys = blocked.slice(0, 5).join(", ");
  const suffix = blocked.length > 5 ? ` (+${blocked.length - 5} more)` : "";
  throw new BadRequestException(
    `${label} contains crawl4ai LLM extraction settings (${keys}${suffix}). ` +
      "The crawl stage must only fetch and store cleaned markdown; run your configured model in the pipeline stage instead."
  );
}
