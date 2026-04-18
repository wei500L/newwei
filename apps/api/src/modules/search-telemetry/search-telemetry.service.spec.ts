import { SearchTelemetryService } from "./search-telemetry.service";

describe("SearchTelemetryService", () => {
  const cache = {
    hincrby: jest.fn(),
    expire: jest.fn(),
    hgetall: jest.fn(),
  } as any;

  let service: SearchTelemetryService;

  beforeEach(() => {
    jest.resetAllMocks();
    service = new SearchTelemetryService(cache);
  });

  it("aggregates daily metrics across a date range", async () => {
    cache.hgetall = jest
      .fn()
      .mockResolvedValueOnce({
        "events.total": "5",
        "events.archive_search_submit": "3",
        "events.archive_query_too_short": "1",
        "events.archive_load_more_click": "1",
        "surface.search_page": "4",
        "surface.events_archive": "1",
        "query_length.len_02_03": "2",
        "load_more.vertical.EAST_SEA": "1",
      })
      .mockResolvedValueOnce({
        "events.total": "2",
        "events.archive_search_submit": "1",
        "events.archive_query_too_short": "0",
        "events.archive_load_more_click": "1",
        "surface.search_page": "1",
        "surface.events_archive": "1",
        "query_length.len_08_15": "1",
        "load_more.vertical.WEST_FRONT": "1",
      });

    const result = await service.getSummary({
      orgId: "org-1",
      from: "2026-04-01",
      to: "2026-04-02",
    });

    expect(cache.hgetall).toHaveBeenCalledTimes(2);
    expect(result.totals.totalEvents).toBe(7);
    expect(result.totals.eventCounts.archive_search_submit).toBe(4);
    expect(result.totals.eventCounts.archive_load_more_click).toBe(2);
    expect(result.totals.surfaceCounts.search_page).toBe(5);
    expect(result.totals.queryLengthBuckets.len_02_03).toBe(2);
    expect(result.totals.loadMoreVerticalCounts.EAST_SEA).toBe(1);
    expect(result.daily).toEqual([
      expect.objectContaining({
        date: "2026-04-01",
        totalEvents: 5,
      }),
      expect.objectContaining({
        date: "2026-04-02",
        totalEvents: 2,
      }),
    ]);
  });

  it("rejects oversized date windows", async () => {
    await expect(
      service.getSummary({
        orgId: "org-1",
        from: "2026-03-01",
        to: "2026-04-18",
      }),
    ).rejects.toThrow("date range cannot exceed 31 days");
  });
});
