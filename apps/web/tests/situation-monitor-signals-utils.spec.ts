import { describe, expect, it } from "vitest";

import {
  isRecentOrefTimestamp,
  parseOrefTimestamp,
  translateOrefTextForLocale,
} from "../app/(app)/situation-monitor/utils/oref-display";
import {
  mergeOrefAlertsRealtime,
  mergeOrefHistoryRealtime,
  mergeTelegramFeedRealtime,
} from "../app/(app)/situation-monitor/utils/realtime-signals";
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

  it("merges realtime Telegram items into the current filtered feed", () => {
    const current = {
      source: "telegram" as const,
      scope: "global" as const,
      earlySignal: true as const,
      configured: true,
      enabled: true,
      channelSet: "default",
      count: 1,
      updatedAt: "2026-03-03T09:00:00.000Z",
      items: [
        {
          id: "old-1",
          source: "telegram" as const,
          channel: "ClashReport",
          channelTitle: "Clash Report",
          url: "https://t.me/a",
          ts: "2026-03-03T09:00:00.000Z",
          text: "Older update",
          topic: "breaking",
          tags: ["tag-a"],
          earlySignal: true,
        },
      ],
      error: "stale",
    };

    const next = mergeTelegramFeedRealtime(
      current,
      {
        count: 2,
        updatedAt: "2026-03-03T10:00:00.000Z",
        items: [
          {
            id: "new-1",
            source: "telegram" as const,
            channel: "clashreport",
            channelTitle: "Clash Report",
            url: "https://t.me/b",
            ts: "2026-03-03T10:00:00.000Z",
            text: "Newest update",
            topic: "Breaking",
            tags: ["tag-b"],
            earlySignal: true,
          },
          {
            id: "skip-1",
            source: "telegram" as const,
            channel: "AnotherChannel",
            channelTitle: "Another Channel",
            url: "https://t.me/c",
            ts: "2026-03-03T10:01:00.000Z",
            text: "Wrong channel",
            topic: "breaking",
            tags: [],
            earlySignal: true,
          },
        ],
        monitorMatches: [
          {
            itemKey: "telegram:new-1",
            itemType: "telegram",
            monitorId: "monitor-a",
            monitorName: "Monitor A",
            monitorColor: "#111111",
            score: 0.91,
            reasons: [],
          } as any,
        ],
      },
      { topic: "breaking", channel: "ClashReport" },
    );

    expect(next).not.toBeNull();
    expect(next?.count).toBe(2);
    expect(next?.updatedAt).toBe("2026-03-03T10:00:00.000Z");
    expect(next?.items.map((item) => item.id)).toEqual(["new-1", "old-1"]);
    expect(next?.monitorMatches?.map((match) => match.itemKey)).toEqual([
      "telegram:new-1",
    ]);
    expect(next).not.toHaveProperty("error");
  });

  it("replaces OREF alerts and appends a realtime history wave", () => {
    const nextAlerts = mergeOrefAlertsRealtime(
      {
        scope: "global" as const,
        configured: true,
        alerts: [],
        historyCount24h: 0,
        totalHistoryCount: 0,
        timestamp: "2026-03-03T09:00:00.000Z",
        monitorMatches: [
          {
            itemKey: "oref:old",
            itemType: "oref_alert",
            monitorId: "monitor-old",
            monitorName: "Old Monitor",
            score: 0.4,
            reasons: [],
          } as any,
        ],
        error: "stale",
      },
      {
        alerts: [
          {
            id: "oref-1",
            cat: "rocket",
            title: "Alert",
            data: ["Ashkelon"],
            desc: "",
            alertDate: "2026-03-03T10:00:00.000Z",
          },
        ],
        historyCount24h: 4,
        totalHistoryCount: 8,
        updatedAt: "2026-03-03T10:00:00.000Z",
        alertMonitorMatches: [
          {
            itemKey: "oref:oref-1",
            itemType: "oref_alert",
            monitorId: "monitor-a",
            monitorName: "Monitor A",
            score: 0.73,
            reasons: [],
          } as any,
        ],
      },
    );

    const nextHistory = mergeOrefHistoryRealtime(
      {
        scope: "global" as const,
        configured: true,
        history: [
          {
            alerts: [
              {
                id: "old",
                cat: "rocket",
                title: "Old alert",
                data: ["Sderot"],
                desc: "",
                alertDate: "2026-03-03T09:00:00.000Z",
              },
            ],
            timestamp: "2026-03-03T09:00:00.000Z",
          },
        ],
        historyCount24h: 1,
        totalHistoryCount: 1,
        timestamp: "2026-03-03T09:00:00.000Z",
        monitorMatches: [
          {
            itemKey: "oref-history:2026-03-03T09:00:00.000Z:old",
            itemType: "oref_history",
            monitorId: "monitor-old",
            monitorName: "Old Monitor",
            score: 0.5,
            reasons: [],
          } as any,
        ],
        error: "stale",
      },
      {
        alerts: [
          {
            id: "oref-1",
            cat: "rocket",
            title: "Alert",
            data: ["Ashkelon"],
            desc: "",
            alertDate: "2026-03-03T10:00:00.000Z",
          },
        ],
        historyCount24h: 4,
        totalHistoryCount: 8,
        updatedAt: "2026-03-03T10:00:00.000Z",
        historyEntry: {
          alerts: [
            {
              id: "oref-1",
              cat: "rocket",
              title: "Alert",
              data: ["Ashkelon"],
              desc: "",
              alertDate: "2026-03-03T10:00:00.000Z",
            },
          ],
          timestamp: "2026-03-03T10:00:01.000Z",
        },
        historyMonitorMatches: [
          {
            itemKey: "oref-history:2026-03-03T10:00:01.000Z:oref-1",
            itemType: "oref_history",
            monitorId: "monitor-a",
            monitorName: "Monitor A",
            score: 0.82,
            reasons: [],
          } as any,
        ],
      },
    );

    expect(nextAlerts?.alerts.map((alert) => alert.id)).toEqual(["oref-1"]);
    expect(nextAlerts?.historyCount24h).toBe(4);
    expect(nextAlerts?.monitorMatches?.map((match) => match.itemKey)).toEqual([
      "oref:oref-1",
    ]);
    expect(nextAlerts).not.toHaveProperty("error");
    expect(nextHistory?.history).toHaveLength(2);
    expect(nextHistory?.history.at(-1)?.timestamp).toBe(
      "2026-03-03T10:00:01.000Z",
    );
    expect(nextHistory?.monitorMatches?.map((match) => match.itemKey)).toEqual([
      "oref-history:2026-03-03T09:00:00.000Z:old",
      "oref-history:2026-03-03T10:00:01.000Z:oref-1",
    ]);
    expect(nextHistory).not.toHaveProperty("error");
  });

  it("does not append an empty OREF realtime payload to history", () => {
    const nextHistory = mergeOrefHistoryRealtime(
      {
        scope: "global" as const,
        configured: true,
        history: [
          {
            alerts: [],
            timestamp: "2026-03-03T09:00:00.000Z",
          },
        ],
        historyCount24h: 1,
        totalHistoryCount: 1,
        timestamp: "2026-03-03T09:00:00.000Z",
      },
      {
        alerts: [],
        historyCount24h: 2,
        totalHistoryCount: 2,
        updatedAt: "2026-03-03T10:00:00.000Z",
      },
    );

    expect(nextHistory?.history).toHaveLength(1);
    expect(nextHistory?.historyCount24h).toBe(2);
    expect(nextHistory?.timestamp).toBe("2026-03-03T10:00:00.000Z");
  });
});

