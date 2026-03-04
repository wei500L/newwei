import { describe, expect, it } from "vitest";

import {
  LIVE_NEWS_CHANNELS,
  LIVE_NEWS_REGIONS,
  PROXIED_HLS_CHANNELS,
} from "../lib/situation-monitor-live-news";

describe("situation monitor live news catalog", () => {
  it("covers at least 18 HLS channels", () => {
    const hlsChannels = LIVE_NEWS_CHANNELS.filter(
      (channel) => channel.sourceMode === "hls-direct" || channel.sourceMode === "hls-proxy",
    );

    expect(hlsChannels.length).toBeGreaterThanOrEqual(18);
  });

  it("contains required channels from the reuse target", () => {
    const ids = new Set(LIVE_NEWS_CHANNELS.map((channel) => channel.id));
    const required = [
      "sky-news",
      "euronews",
      "dw",
      "france24",
      "alarabiya",
      "cbs-news",
      "trt-world",
      "sky-news-arabia",
      "al-hadath",
      "rt",
      "abc-news-au",
      "tagesschau24",
      "india-today",
      "kan-11",
      "tv5monde-info",
      "arise-news",
      "nhk-world",
      "fox-news",
      "cnn",
      "cnbc",
    ];

    for (const id of required) {
      expect(ids.has(id)).toBe(true);
    }
  });

  it("keeps RT as HLS-only", () => {
    const rt = LIVE_NEWS_CHANNELS.find((channel) => channel.id === "rt");
    expect(rt).toBeTruthy();
    expect(rt?.sourceMode).toBe("hls-direct");
    expect(rt?.allowYoutubeFallback).toBe(false);
    expect(rt?.fallbackVideoId).toBeUndefined();
  });

  it("validates direct HLS URL format", () => {
    const direct = LIVE_NEWS_CHANNELS.filter((channel) => channel.sourceMode === "hls-direct");
    for (const channel of direct) {
      expect(channel.hlsUrl).toBeTruthy();
      expect(channel.hlsUrl?.startsWith("https://")).toBe(true);
      expect(channel.hlsUrl?.includes(".m3u8")).toBe(true);
    }
  });

  it("validates proxied channel mapping", () => {
    const proxied = LIVE_NEWS_CHANNELS.filter((channel) => channel.sourceMode === "hls-proxy");
    expect(proxied.length).toBe(PROXIED_HLS_CHANNELS.length);
    for (const channel of proxied) {
      expect(channel.proxyChannel).toBeTruthy();
      expect(PROXIED_HLS_CHANNELS.includes(channel.proxyChannel!)).toBe(true);
    }
  });

  it("exposes Africa and Oceania regions", () => {
    const regionKeys = new Set(LIVE_NEWS_REGIONS.map((region) => region.key));
    expect(regionKeys.has("africa")).toBe(true);
    expect(regionKeys.has("oceania")).toBe(true);
  });
});
