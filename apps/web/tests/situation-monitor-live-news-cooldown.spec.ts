import { describe, expect, it } from "vitest";

import {
  getHlsCooldownUntil,
  markHlsFailure,
  resolveLiveNewsPlaybackMode,
  shouldResolveYoutubeLiveId,
} from "../lib/situation-monitor-live-news";

describe("situation monitor live news cooldown", () => {
  it("marks failure and expires cooldown", () => {
    const map = new Map<string, number>();
    const baseNow = 1_000;

    const cooldownUntil = markHlsFailure(map, "cnn", baseNow, 300_000);
    expect(cooldownUntil).toBe(301_000);
    expect(getHlsCooldownUntil(map, "cnn", baseNow + 10_000)).toBe(301_000);
    expect(getHlsCooldownUntil(map, "cnn", baseNow + 301_001)).toBeNull();
    expect(map.has("cnn")).toBe(false);
  });

  it("falls back to youtube while in cooldown then retries hls", () => {
    const map = new Map<string, number>();
    const baseNow = 5_000;
    markHlsFailure(map, "cnbc", baseNow, 300_000);

    const modeDuringCooldown = resolveLiveNewsPlaybackMode({
      hlsUrl: "/api/situation-monitor/hls-proxy?channel=cnbc",
      cooldownUntil: getHlsCooldownUntil(map, "cnbc", baseNow + 60_000),
      forceYoutube: true,
      allowYoutubeFallback: true,
      youtubeVideoId: "9NyxcX3rhQs",
      now: baseNow + 60_000,
    });

    const modeAfterCooldown = resolveLiveNewsPlaybackMode({
      hlsUrl: "/api/situation-monitor/hls-proxy?channel=cnbc",
      cooldownUntil: getHlsCooldownUntil(map, "cnbc", baseNow + 301_000),
      forceYoutube: false,
      allowYoutubeFallback: true,
      youtubeVideoId: "9NyxcX3rhQs",
      now: baseNow + 301_000,
    });

    expect(modeDuringCooldown).toBe("youtube");
    expect(modeAfterCooldown).toBe("hls");
  });

  it("stays hls-only for RT while in cooldown", () => {
    const mode = resolveLiveNewsPlaybackMode({
      hlsUrl: "https://rt-glb.rttv.com/dvr/rtnews/playlist.m3u8",
      cooldownUntil: Date.now() + 60_000,
      forceYoutube: true,
      allowYoutubeFallback: false,
      youtubeVideoId: null,
    });

    expect(mode).toBe("hls-only");
  });

  it("resolves youtube live id for youtube-only channels without static fallback id", () => {
    const shouldResolve = shouldResolveYoutubeLiveId({
      sourceMode: "youtube-only",
      youtubeHandle: "@ABCNews",
      allowYoutubeFallback: true,
      forceYoutube: true,
      cooldownUntil: null,
    });

    expect(shouldResolve).toBe(true);
  });

  it("resolves youtube live id when hls fallback is needed", () => {
    const byHlsFailure = shouldResolveYoutubeLiveId({
      sourceMode: "hls-direct",
      youtubeHandle: "@SkyNews",
      allowYoutubeFallback: true,
      forceYoutube: true,
      cooldownUntil: Date.now() + 30_000,
    });

    const byProxyUnavailable = shouldResolveYoutubeLiveId({
      sourceMode: "hls-proxy",
      youtubeHandle: "@CNN",
      allowYoutubeFallback: true,
      forceYoutube: false,
      cooldownUntil: null,
      proxyConfigured: false,
    });

    expect(byHlsFailure).toBe(true);
    expect(byProxyUnavailable).toBe(true);
  });
});
