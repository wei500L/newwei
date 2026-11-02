import { describe, expect, it } from "vitest";

import { buildSitemapDiagnosticRows } from "./crawl-frontier-diagnostics";

describe("buildSitemapDiagnosticRows", () => {
  it("projects the persisted sitemap diagnostics into labelled rows", () => {
    const rows = buildSitemapDiagnosticRows({
      discoveryMode: "robots",
      seedMethod: "robots",
      robotsUrl: "https://example.com/robots.txt",
      robotsDiscoveredSitemaps: ["https://example.com/sitemap-a.xml"],
      attemptedSitemaps: ["https://example.com/sitemap-a.xml", "https://example.com/child.xml"],
      fetchedSitemaps: ["https://example.com/sitemap-a.xml", "https://example.com/child.xml"],
      parsedSitemaps: 2,
      candidateCount: 7,
    });

    const byKey = Object.fromEntries(rows.map((row) => [row.key, row.value]));
    expect(byKey.discoveryMode).toBe("robots");
    expect(byKey.seedMethod).toBe("robots");
    expect(byKey.robotsUrl).toBe("https://example.com/robots.txt");
    expect(byKey.robotsDiscoveredSitemaps).toBe("1");
    expect(byKey.attemptedSitemaps).toBe("2");
    expect(byKey.fetchedSitemaps).toBe("2");
    expect(byKey.parsedSitemaps).toBe("2");
    expect(byKey.candidateCount).toBe("7");
  });

  it("keeps every row with a fallback when the document is absent or partial", () => {
    const rows = buildSitemapDiagnosticRows(undefined);
    expect(rows).toHaveLength(8);
    for (const row of rows) {
      expect(row.value).toBe("-");
    }

    const partial = Object.fromEntries(
      buildSitemapDiagnosticRows({ discoveryMode: "disabled", seedMethod: "none" }).map((row) => [
        row.key,
        row.value,
      ]),
    );
    expect(partial.discoveryMode).toBe("disabled");
    expect(partial.seedMethod).toBe("none");
    expect(partial.robotsUrl).toBe("-");
    expect(partial.candidateCount).toBe("-");
  });

  it("renders empty sitemap lists as zero rather than a dash", () => {
    const byKey = Object.fromEntries(
      buildSitemapDiagnosticRows({
        discoveryMode: "disabled",
        seedMethod: "none",
        robotsDiscoveredSitemaps: [],
        attemptedSitemaps: [],
        fetchedSitemaps: [],
        parsedSitemaps: 0,
        candidateCount: 0,
      }).map((row) => [row.key, row.value]),
    );
    expect(byKey.robotsDiscoveredSitemaps).toBe("0");
    expect(byKey.attemptedSitemaps).toBe("0");
    expect(byKey.fetchedSitemaps).toBe("0");
    expect(byKey.parsedSitemaps).toBe("0");
    expect(byKey.candidateCount).toBe("0");
  });
});
