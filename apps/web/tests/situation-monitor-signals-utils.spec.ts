import { describe, expect, it } from "vitest";

import {
  isRecentOrefTimestamp,
  parseOrefTimestamp,
  translateOrefTextForLocale,
} from "../app/(app)/situation-monitor/utils/oref-display";
import { buildTelegramFeedQueryParams } from "../app/(app)/situation-monitor/utils/telegram-feed";

describe("situation monitor signal utilities", () => {
  it("translates known OREF Hebrew text when translateToZh is enabled", () => {
    expect(
      translateOrefTextForLocale("ירי רקטות וטילים", { translateToZh: true }),
    ).toBe("火箭与导弹来袭");
    expect(
      translateOrefTextForLocale("ירי רקטות וטילים", { translateToZh: false }),
    ).toBe("ירי רקטות וטילים");
  });

  it("parses OREF timestamps from ISO and space-separated formats", () => {
    const iso = parseOrefTimestamp("2026-03-03T10:30:00.000Z");
    const spaced = parseOrefTimestamp("2026-03-03 10:30:00");
    expect(iso).not.toBeNull();
    expect(spaced).not.toBeNull();
  });

  it("detects recent OREF timestamps inside a time window", () => {
    const nowMs = Date.parse("2026-03-03T12:00:00.000Z");
    expect(
      isRecentOrefTimestamp("2026-03-03T11:40:00.000Z", {
        nowMs,
        windowMinutes: 30,
      }),
    ).toBe(true);
    expect(
      isRecentOrefTimestamp("2026-03-03T10:50:00.000Z", {
        nowMs,
        windowMinutes: 30,
      }),
    ).toBe(false);
  });

  it("builds Telegram feed params from filters", () => {
    expect(
      buildTelegramFeedQueryParams(
        { topic: "all", channel: "all" },
        { limit: 80 },
      ),
    ).toEqual({ limit: 80, topic: undefined, channel: undefined });

    expect(
      buildTelegramFeedQueryParams(
        { topic: "breaking", channel: "ClashReport" },
        { limit: 100 },
      ),
    ).toEqual({ limit: 100, topic: "breaking", channel: "ClashReport" });
  });
});

