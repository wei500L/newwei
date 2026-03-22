import { createHash } from "node:crypto";

export interface ComparableUrlVariants {
  full: string;
  base: string;
  fullHash: string;
}

export const hashComparableUrl = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

const normalizeComparableHttpUrl = (
  parsed: URL,
  options: { keepSearch: boolean },
): string => {
  parsed.hash = "";
  parsed.hostname = parsed.hostname.toLowerCase();
  if (!options.keepSearch) {
    parsed.search = "";
  }
  if (parsed.pathname !== "/") {
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  }
  const normalized = parsed.toString();
  return normalized.endsWith("/") && parsed.pathname === "/"
    ? normalized.slice(0, -1)
    : normalized;
};

export const buildComparableUrlVariants = (
  value: string,
): ComparableUrlVariants | null => {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }

    const full = normalizeComparableHttpUrl(new URL(parsed.toString()), { keepSearch: true });
    return {
      full,
      base: normalizeComparableHttpUrl(new URL(parsed.toString()), { keepSearch: false }),
      fullHash: hashComparableUrl(full),
    };
  } catch {
    return null;
  }
};
