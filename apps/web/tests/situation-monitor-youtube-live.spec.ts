import { afterEach, describe, expect, it, vi } from "vitest";

import {
  __clearSituationMonitorYouTubeLiveCacheForTests,
  fetchSituationMonitorYouTubeLiveInfo,
} from "../lib/situation-monitor-youtube-live";

afterEach(() => {
  __clearSituationMonitorYouTubeLiveCacheForTests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("situation monitor youtube live service", () => {
  it("normalizes handle and parses response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          videoId: "abc123def45",
          isLive: true,
          channelExists: true,
          channelName: "Test Channel",
          hlsUrl: "https://example.com/live.m3u8",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchSituationMonitorYouTubeLiveInfo("CNN");

    expect(result.videoId).toBe("abc123def45");
    expect(result.isLive).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calledUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(calledUrl).toContain("channel=%40CNN");
  });

  it("uses cache to avoid repeated network calls", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ videoId: "abc123def45", isLive: true, channelExists: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    vi.stubGlobal("fetch", fetchMock);

    await fetchSituationMonitorYouTubeLiveInfo("@CNBC");
    await fetchSituationMonitorYouTubeLiveInfo("CNBC");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns safe fallback on errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));

    const result = await fetchSituationMonitorYouTubeLiveInfo("@DWNews");

    expect(result.videoId).toBeNull();
    expect(result.isLive).toBe(false);
    expect(result.channelExists).toBe(false);
  });
});
