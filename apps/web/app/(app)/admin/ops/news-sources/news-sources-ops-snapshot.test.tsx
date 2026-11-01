import { screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { i18n, renderWithProviders } from "@/test/render";

import { mapNewsSourceRecord } from "./news-sources.helpers";
import { NewsSourcesTable } from "./news-sources-table";
import type {
  NewsSourceApiRecord,
  NewsSourceRecord,
} from "./news-sources.types";

// The stats24h/latest columns are marked `responsive: ["md"]`. jsdom's shared
// matchMedia stub reports every query as non-matching, which hides those
// columns from antd's Table. Report a desktop viewport for the duration of this
// suite so the columns that carry the backfilled values actually render.
function createDesktopMatchMedia(query: string) {
  return {
    matches: /min-width/.test(query),
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  };
}

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: createDesktopMatchMedia,
  });
  Object.defineProperty(globalThis, "matchMedia", {
    configurable: true,
    writable: true,
    value: createDesktopMatchMedia,
  });
});

// A raw record shaped exactly like GET /api/admin/news-sources returns for a
// source that only had ops snapshots written lazily by the list backfill: the
// latest job/task/article and 24h stats are present alongside the runtime block
// that was already written by the scheduler.
const backfilledApiRecord: NewsSourceApiRecord = {
  id: "source-snap-1",
  name: "Snapshot Source",
  url: "https://example.com/source-snap-1",
  siteType: "general",
  frequencySeconds: 3600,
  priority: 0,
  isActive: true,
  config: null,
  opsSummary: {
    latestJob: {
      id: "job-snap-1",
      status: "completed",
      url: "https://example.com/source-snap-1/a",
      createdAt: "2026-10-20T10:00:00.000Z",
      startedAt: "2026-10-20T10:00:01.000Z",
      completedAt: "2026-10-20T10:00:02.500Z",
      error: null,
      metadata: null,
    },
    latestCrawlTask: {
      id: "task-snap-1",
      status: "succeeded",
      lastError: null,
      lastRunAt: "2026-10-20T10:00:01.000Z",
      lastSuccessAt: "2026-10-20T10:00:02.000Z",
      lastResultAt: "2026-10-20T10:00:02.500Z",
    },
    latestArticle: {
      id: "article-snap-1",
      url: "https://example.com/source-snap-1/a",
      crawlAt: "2026-10-20T10:00:02.000Z",
      titleGuess: "Backfilled article title",
    },
    stats24h: {
      completed: 2,
      failed: 0,
      successRate: 1,
      avgDurationMs: 1500,
    },
    runtime: {
      crawlTaskQueuedCount: 3,
      crawlTaskRunningCount: 1,
      backpressureUntil: null,
      backpressurePendingJobs: null,
      backpressureThreshold: null,
      backpressureCount24h: 0,
      rssAdaptiveState: null,
    },
  },
};

function TableHarness({ records }: { records: NewsSourceRecord[] }) {
  return (
    <NewsSourcesTable
      t={i18n.t.bind(i18n) as never}
      locale="en-US"
      router={{ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() } as never}
      canManage={false}
      screens={{} as never}
      sources={records}
      loading={false}
      sourcePage={1}
      sourcePageSize={10}
      sourceTotal={records.length}
      setSourcePage={() => {}}
      setSourcePageSize={() => {}}
      searchInput=""
      setSearchInput={() => {}}
      selectedSourceIds={[]}
      setSelectedSourceIds={() => {}}
      selectedSources={[]}
      uniqueGroups={[]}
      templateMap={new Map()}
      siteTypeOptions={[{ value: "general", label: "General" }]}
      resolveRssAdaptiveObservability={() => null}
      dispatchingSourceIds={new Set()}
      opsLoadingSourceIds={new Set()}
      setOpsLoadingSourceIds={() => {}}
      batchRunLoading={false}
      setBatchRunLoading={() => {}}
      batchToggleLoading={false}
      setBatchToggleLoading={() => {}}
      batchGroupLoading={false}
      setBatchGroupLoading={() => {}}
      scheduleLoading={false}
      apiClient={{} as never}
      loadSources={async () => true}
      loadGroups={async () => {}}
      messageApi={{} as never}
      handleRunNow={async () => {}}
      openEdit={() => {}}
      handlePreview={async () => {}}
      openSchedule={() => {}}
      openBatchSchedule={() => {}}
    />
  );
}

describe("NewsSourcesTable ops snapshot display", () => {
  it("renders the backfilled latest activity and 24h stats alongside the runtime counts", async () => {
    await i18n.changeLanguage("en-US");
    renderWithProviders(
      <TableHarness records={[mapNewsSourceRecord(backfilledApiRecord)]} />,
    );

    // Latest job status and article title from the backfilled snapshot.
    expect((await screen.findAllByText("completed")).length).toBeGreaterThan(0);
    expect(
      (await screen.findAllByText("Backfilled article title")).length,
    ).toBeGreaterThan(0);

    // 24h completed/failed pair and success rate.
    expect((await screen.findAllByText("2/0")).length).toBeGreaterThan(0);
    expect((await screen.findAllByText("100%")).length).toBeGreaterThan(0);

    // Runtime queued/running counts that the scheduler wrote are preserved.
    expect((await screen.findAllByText("Queued: 3")).length).toBeGreaterThan(0);
    expect((await screen.findAllByText("Active: 1")).length).toBeGreaterThan(0);
  });
});
