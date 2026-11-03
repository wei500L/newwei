import type { WarMapEvent, WarMapNewsMarker } from "@modular/utils";
import { describe, expect, it } from "vitest";

import {
  clampIntelText,
  eventsToGeojsonl,
  INTEL_MAX_NAME,
  INTEL_MAX_POINTS,
  isValidCoordinate,
  newsMarkersToGeojsonl,
} from "./intel-geojson";

function event(overrides: Partial<WarMapEvent> = {}): WarMapEvent {
  return {
    id: "evt-1",
    name: "Border incident",
    lat: 10,
    lng: 20,
    severity: "high",
    derivedScore: 9,
    value: 9,
    ...overrides,
  };
}

function marker(overrides: Partial<WarMapNewsMarker> = {}): WarMapNewsMarker {
  return {
    id: "news-1",
    title: "Shipping lane reopens",
    location: "Suez",
    lat: 30,
    lng: 32,
    geoSource: "geocoded",
    ...overrides,
  };
}

function parseLines(geojsonl: string): Record<string, unknown>[] {
  if (!geojsonl) return [];
  return geojsonl.split("\n").map((line) => JSON.parse(line));
}

describe("intel-geojson", () => {
  it("转换正常事件（地区聚合）：一行一个合法 Feature，带 kind/计数/地区搜索链接", () => {
    const lines = parseLines(
      eventsToGeojsonl([event({ newsCount: 3, alertCount: 2 })], {
        locale: "en-US",
      }),
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      type: "Feature",
      id: "evt:evt-1",
      geometry: { type: "Point", coordinates: [20, 10] },
      properties: {
        name: "Border incident",
        kind: "region",
        severity: "high",
        consoleUrl: "/search?q=Border%20incident",
        newweiId: "evt-1",
        countryCode: "evt-1",
        newsCount: 3,
        alertCount: 2,
        score: 9,
      },
    });
  });

  it("新闻转换不带 consoleUrl，只保留合法的 http(s) 原文 url", () => {
    const lines = parseLines(
      newsMarkersToGeojsonl(
        [
          marker({
            publishedAt: "2026-01-02T00:00:00.000Z",
            url: "https://example.com/article",
          }),
        ],
        { locale: "en-US" },
      ),
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      id: "news:news-1",
      properties: {
        kind: "news",
        newweiId: "news-1",
        time: "2026-01-02T00:00:00.000Z",
        location: "Suez",
        url: "https://example.com/article",
      },
    });
    expect(
      (lines[0]!.properties as Record<string, unknown>).consoleUrl,
    ).toBeUndefined();
  });

  it("新闻的 javascript: url 被丢弃", () => {
    const [line] = parseLines(
      newsMarkersToGeojsonl(
        [marker({ url: "javascript:alert(1)" })],
        { locale: "en-US" },
      ),
    );
    expect((line!.properties as Record<string, unknown>).url).toBeUndefined();
  });

  it("丢弃无效坐标（NaN / 越界）", () => {
    const output = eventsToGeojsonl(
      [
        event({ id: "ok", lat: 10, lng: 20 }),
        event({ id: "nan", lat: Number.NaN, lng: 20 }),
        event({ id: "lat-out", lat: 91, lng: 20 }),
        event({ id: "lng-out", lat: 10, lng: 181 }),
      ],
      {},
    );
    const ids = parseLines(output).map((line) => line.id);
    expect(ids).toEqual(["evt:ok"]);
    expect(isValidCoordinate(91, 20)).toBe(false);
    expect(isValidCoordinate(10, 181)).toBe(false);
    expect(isValidCoordinate(10, 20)).toBe(true);
  });

  it("事件按严重程度降序截断", () => {
    const events = [
      event({ id: "low", severity: "low", derivedScore: 100 }),
      event({ id: "high", severity: "high", derivedScore: 1 }),
      event({ id: "medium", severity: "medium", derivedScore: 50 }),
    ];
    const ids = parseLines(eventsToGeojsonl(events, {})).map(
      (line) => (line.properties as { newweiId: string }).newweiId,
    );
    expect(ids).toEqual(["high", "medium", "low"]);
  });

  it("新闻按时间倒序截断", () => {
    const markers = [
      marker({ id: "old", publishedAt: "2026-01-01T00:00:00.000Z" }),
      marker({ id: "new", publishedAt: "2026-03-01T00:00:00.000Z" }),
      marker({ id: "mid", publishedAt: "2026-02-01T00:00:00.000Z" }),
    ];
    const ids = parseLines(newsMarkersToGeojsonl(markers, {})).map(
      (line) => (line.properties as { newweiId: string }).newweiId,
    );
    expect(ids).toEqual(["new", "mid", "old"]);
  });

  it("每类最多 2000 个点", () => {
    const many = Array.from({ length: INTEL_MAX_POINTS + 25 }, (_, index) =>
      event({ id: `e-${index}`, lat: 0, lng: 0, derivedScore: index }),
    );
    const lines = parseLines(eventsToGeojsonl(many, {}));
    expect(lines).toHaveLength(INTEL_MAX_POINTS);
  });

  it("标题换行替换为空格并截断到 80 字", () => {
    const longName = `${"A\n".repeat(3)}${"字".repeat(100)}`;
    const [line] = parseLines(eventsToGeojsonl([event({ name: longName })], {}));
    const name = (line!.properties as { name: string }).name;
    expect(name).not.toContain("\n");
    expect(Array.from(name)).toHaveLength(INTEL_MAX_NAME);
    expect(clampIntelText("a\nb", 10)).toBe("a b");
  });

  it("输出的每一行都能被 JSON.parse 解析", () => {
    const output = [
      eventsToGeojsonl([event()], {}),
      newsMarkersToGeojsonl([marker()], {}),
    ]
      .filter(Boolean)
      .join("\n");
    for (const line of output.split("\n")) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it("空输入返回空字符串", () => {
    expect(eventsToGeojsonl([], {})).toBe("");
    expect(newsMarkersToGeojsonl([], {})).toBe("");
  });
});
