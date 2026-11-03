import { describe, expect, it } from "vitest";

import {
  buildGlobeHref,
  GLOBE_LABEL_MAX,
  isValidLatLon,
  parseGlobeParams,
  truncateGlobeLabel,
} from "./globe-link";

describe("globe-link", () => {
  it("构造带坐标、标题与 focus 的链接", () => {
    const href = buildGlobeHref({
      lat: 35.5,
      lon: 105.2,
      label: "Strait incident",
      focus: { layerId: "newwei-events", newweiId: "evt-1" },
    });
    expect(href).toBe(
      "/globe?lat=35.5&lon=105.2&label=Strait+incident&focus=newwei-events%3Aevt-1",
    );
  });

  it("无效坐标被丢弃", () => {
    expect(buildGlobeHref({ lat: Number.NaN, lon: 20 })).toBe("/globe");
    expect(buildGlobeHref({ lat: 91, lon: 20 })).toBe("/globe");
    expect(buildGlobeHref({ lat: 10, lon: 181 })).toBe("/globe");
    expect(isValidLatLon(10, 20)).toBe(true);
    expect(isValidLatLon(91, 20)).toBe(false);
  });

  it("标题截断到 80 字并去掉换行", () => {
    const long = `a\n${"字".repeat(200)}`;
    const label = truncateGlobeLabel(long);
    expect(label).not.toContain("\n");
    expect(Array.from(label)).toHaveLength(GLOBE_LABEL_MAX);
  });

  it("解析参数往返一致", () => {
    const href = buildGlobeHref({
      lat: -12.25,
      lon: 130.5,
      label: "Darwin",
      focus: { layerId: "newwei-news", newweiId: "news-9" },
    });
    const params = parseGlobeParams(new URLSearchParams(href.split("?")[1]));
    expect(params.lat).toBe(-12.25);
    expect(params.lon).toBe(130.5);
    expect(params.label).toBe("Darwin");
    expect(params.focus).toEqual({
      layerId: "newwei-news",
      newweiId: "news-9",
    });
  });

  it("解析时忽略无效坐标与畸形 focus", () => {
    const params = parseGlobeParams(
      new URLSearchParams("lat=abc&lon=20&focus=newwei-events"),
    );
    expect(params.lat).toBeUndefined();
    expect(params.lon).toBeUndefined();
    expect(params.focus).toBeUndefined();
  });

  it("focus 的 newweiId 可包含冒号", () => {
    const params = parseGlobeParams(
      new URLSearchParams("focus=newwei-events:evt:abc"),
    );
    expect(params.focus).toEqual({
      layerId: "newwei-events",
      newweiId: "evt:abc",
    });
  });
});
