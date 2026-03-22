import {
  buildCrawlQualityTaskSnapshotRows,
  normalizeCrawlQualitySourceId,
} from "../crawl-quality-task-snapshot.helpers";

describe("crawl-quality-task-snapshot helpers", () => {
  it("prefers newsSourceId before config and displayName fallbacks", () => {
    expect(
      normalizeCrawlQualitySourceId({
        newsSourceId: "source-1",
        config: {
          itemPayload: { metadata: { sourceId: "source-2" } },
        },
        displayName: "NewsSource:source-3:https://example.com",
      }),
    ).toBe("source-1");

    expect(
      normalizeCrawlQualitySourceId({
        newsSourceId: null,
        config: {
          itemPayload: { metadata: { sourceId: "source-2" } },
        },
        displayName: "NewsSource:source-3:https://example.com",
      }),
    ).toBe("source-2");

    expect(
      normalizeCrawlQualitySourceId({
        newsSourceId: null,
        config: null,
        displayName: "NewsSource:source-3:https://example.com",
      }),
    ).toBe("source-3");

    expect(
      normalizeCrawlQualitySourceId({
        newsSourceId: null,
        config: null,
        displayName: null,
      }),
    ).toBe("unknown");
  });

  it("builds zero-filled task snapshot rows and overlays aggregate counters", () => {
    const rolledAt = new Date("2026-03-22T10:05:00.000Z");
    const rows = buildCrawlQualityTaskSnapshotRows(
      [
        {
          id: "task-1",
          orgId: "org-1",
          newsSourceId: "source-1",
          displayName: null,
          config: null,
          createdAt: new Date("2026-03-22T10:00:00.000Z"),
          updatedAt: new Date("2026-03-22T10:04:00.000Z"),
        },
        {
          id: "task-2",
          orgId: "org-1",
          newsSourceId: null,
          displayName: null,
          config: null,
          createdAt: new Date("2026-03-22T10:01:00.000Z"),
          updatedAt: new Date("2026-03-22T10:04:00.000Z"),
        },
      ],
      {
        expansionRows: [
          {
            taskId: "task-1",
            lowSignalTaskCount: 1,
            expansionTriggeredTaskCount: 1,
            expansionImprovedTaskCount: 1,
            candidateRejectIncludePatternCount: 2,
            candidateRejectExcludePatternCount: 3,
            candidateRejectPublishConfidenceCount: 4,
            publishConfidenceLt04Count: 1,
            publishConfidenceFrom04To06Count: 2,
            publishConfidenceFrom06To08Count: 3,
            publishConfidenceGte08Count: 4,
            fitMarkdownPreferenceTaskCount: 1,
            headSignalAttemptedCount: 4,
            headSignalSucceededCount: 3,
            headSignalSoftFailureCount: 1,
            headSignalTruncatedCount: 1,
            headSignalNoPublishSignalCount: 1,
          },
        ],
        preflightRows: [
          {
            taskId: "task-1",
            preflightRunCount: 2,
            preflightFailureCount: 1,
            preflight304HitCount: 1,
          },
        ],
        dedupeRows: [
          {
            taskId: "task-1",
            dedupeEvaluatedCount: 10,
            dedupeOrgReuseCount: 4,
          },
        ],
        markdownRows: [
          {
            taskId: "task-1",
            markdownCount: 2,
            markdownCharsTotal: 120,
            emptyMarkdownCount: 1,
          },
        ],
      },
      rolledAt,
    );

    expect(rows[0]).toMatchObject({
      taskId: "task-1",
      orgId: "org-1",
      sourceId: "source-1",
      rolledAt,
      lowSignalTaskCount: 1,
      expansionTriggeredTaskCount: 1,
      expansionImprovedTaskCount: 1,
      markdownCount: 2,
      markdownCharsTotal: 120,
      emptyMarkdownCount: 1,
      candidateRejectIncludePatternCount: 2,
      candidateRejectExcludePatternCount: 3,
      candidateRejectPublishConfidenceCount: 4,
      publishConfidenceLt04Count: 1,
      publishConfidenceFrom04To06Count: 2,
      publishConfidenceFrom06To08Count: 3,
      publishConfidenceGte08Count: 4,
      fitMarkdownPreferenceTaskCount: 1,
      headSignalAttemptedCount: 4,
      headSignalSucceededCount: 3,
      headSignalSoftFailureCount: 1,
      headSignalTruncatedCount: 1,
      headSignalNoPublishSignalCount: 1,
      preflightRunCount: 2,
      preflightFailureCount: 1,
      preflight304HitCount: 1,
      dedupeEvaluatedCount: 10,
      dedupeOrgReuseCount: 4,
    });
    expect(rows[1]).toMatchObject({
      taskId: "task-2",
      orgId: "org-1",
      sourceId: "unknown",
      rolledAt,
      lowSignalTaskCount: 0,
      expansionTriggeredTaskCount: 0,
      expansionImprovedTaskCount: 0,
      markdownCount: 0,
      markdownCharsTotal: 0,
      emptyMarkdownCount: 0,
      preflightRunCount: 0,
      dedupeEvaluatedCount: 0,
    });
  });
});
