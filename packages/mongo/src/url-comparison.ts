export interface ComparableUrlVariants {
  full: string;
  base: string;
}

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

    return {
      full: normalizeComparableHttpUrl(new URL(parsed.toString()), { keepSearch: true }),
      base: normalizeComparableHttpUrl(new URL(parsed.toString()), { keepSearch: false }),
    };
  } catch {
    return null;
  }
};
