// Sitemap discovery diagnostics projection for the Frontier run drawer.
//
// The backend stores the CrawlSitemapDiscoveryDiagnostics document unchanged on
// the run (summary.seedSummary.diagnostics) and node metadata. This module turns
// that raw record into the labelled rows the diagnostics card renders, keeping
// the display resilient to a missing document or a less complete older run. It is
// a pure function so it can be covered without rendering the whole console.

type AnyRecord = Record<string, unknown>;

export interface SitemapDiagnosticRow {
  key: string;
  label: string;
  value: string;
}

function asRecord(value: unknown): AnyRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as AnyRecord)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function asArrayLength(value: unknown): number | undefined {
  return Array.isArray(value) ? value.length : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

// buildSitemapDiagnosticRows maps the persisted sitemap diagnostics to the rows
// the console shows. Every row is always present so a partial/absent document
// renders "-" instead of collapsing the card.
export function buildSitemapDiagnosticRows(diagnostics: unknown): SitemapDiagnosticRow[] {
  const record = asRecord(diagnostics);
  const count = (value: unknown): string => {
    const length = asArrayLength(value);
    return length === undefined ? "-" : String(length);
  };
  const number = (value: unknown): string => {
    const parsed = asNumber(value);
    return parsed === undefined ? "-" : String(parsed);
  };
  return [
    { key: "discoveryMode", label: "Discovery mode", value: asString(record?.discoveryMode) ?? "-" },
    { key: "seedMethod", label: "Seed method", value: asString(record?.seedMethod) ?? "-" },
    { key: "robotsUrl", label: "Robots URL", value: asString(record?.robotsUrl) ?? "-" },
    {
      key: "robotsDiscoveredSitemaps",
      label: "Robots-discovered sitemaps",
      value: count(record?.robotsDiscoveredSitemaps),
    },
    { key: "attemptedSitemaps", label: "Attempted sitemaps", value: count(record?.attemptedSitemaps) },
    { key: "fetchedSitemaps", label: "Fetched sitemaps", value: count(record?.fetchedSitemaps) },
    { key: "parsedSitemaps", label: "Parsed sitemaps", value: number(record?.parsedSitemaps) },
    { key: "candidateCount", label: "Candidate count", value: number(record?.candidateCount) },
  ];
}
