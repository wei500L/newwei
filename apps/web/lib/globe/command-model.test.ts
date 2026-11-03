import { describe, expect, it } from "vitest";

import {
  GLOBE_MAP_STACKS,
  GLOBE_STYLES,
  parseCoordinateQuery,
  placeKindFromTypes,
  styleIdForKey,
} from "./command-model";

describe("GLOBE_STYLES", () => {
  it("共 6 项，顺序与按键和 STYLE_KEYS（1–6）一致", () => {
    expect(GLOBE_STYLES).toHaveLength(6);
    expect(GLOBE_STYLES.map((style) => style.id)).toEqual([
      "normal",
      "retro",
      "surveillance",
      "thermal",
      "anime",
      "noir",
    ]);
    expect(GLOBE_STYLES.map((style) => style.key)).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
    ]);
    expect(GLOBE_STYLES.map((style) => style.labelKey)).toEqual([
      "globe.styles.normal",
      "globe.styles.retro",
      "globe.styles.surveillance",
      "globe.styles.thermal",
      "globe.styles.anime",
      "globe.styles.noir",
    ]);
  });

  it("styleIdForKey 映射按键", () => {
    expect(styleIdForKey("3")).toBe("surveillance");
    expect(styleIdForKey("6")).toBe("noir");
    expect(styleIdForKey("9")).toBeUndefined();
  });
});

describe("GLOBE_MAP_STACKS", () => {
  it("只包含不需要 Cesium ion 的三种底图", () => {
    expect(GLOBE_MAP_STACKS.map((stack) => stack.id)).toEqual([
      "photoreal",
      "esri-imagery",
      "osm",
    ]);
  });

  it("photoreal 需要 Google 密钥，其余不需要", () => {
    expect(
      GLOBE_MAP_STACKS.find((stack) => stack.id === "photoreal")
        ?.requiresGoogleKey,
    ).toBe(true);
    expect(
      GLOBE_MAP_STACKS.find((stack) => stack.id === "esri-imagery")
        ?.requiresGoogleKey,
    ).toBe(false);
    expect(
      GLOBE_MAP_STACKS.find((stack) => stack.id === "osm")?.requiresGoogleKey,
    ).toBe(false);
  });
});

describe("parseCoordinateQuery", () => {
  it("识别 lat, lon", () => {
    expect(parseCoordinateQuery("31.23, 121.47")).toEqual({
      lat: 31.23,
      lon: 121.47,
      label: "31.2300, 121.4700",
    });
  });

  it("识别 lat lon", () => {
    expect(parseCoordinateQuery("31.23 121.47")).toMatchObject({
      lat: 31.23,
      lon: 121.47,
    });
    expect(parseCoordinateQuery("-33.8688  151.2093")).toMatchObject({
      lat: -33.8688,
      lon: 151.2093,
    });
  });

  it("识别 geo:lat,lon URI", () => {
    expect(parseCoordinateQuery("geo:31.23,121.47")).toMatchObject({
      lat: 31.23,
      lon: 121.47,
    });
    expect(parseCoordinateQuery("geo:31.23,121.47;crs=wgs84")).toMatchObject({
      lat: 31.23,
      lon: 121.47,
    });
  });

  it("拒绝地名、含糊输入与越界坐标", () => {
    expect(parseCoordinateQuery("Tokyo")).toBeNull();
    expect(parseCoordinateQuery("12junk, 34oops")).toBeNull();
    expect(parseCoordinateQuery("31.2.3, 121.4")).toBeNull();
    expect(parseCoordinateQuery("95, 10")).toBeNull();
    expect(parseCoordinateQuery("10, 200")).toBeNull();
    expect(parseCoordinateQuery("")).toBeNull();
    expect(parseCoordinateQuery("31.2, 121.4, 5")).toBeNull();
  });
});

describe("placeKindFromTypes", () => {
  it("按 types 归纳 kicker 类型", () => {
    expect(placeKindFromTypes(["coordinate"])).toBe("coordinate");
    expect(placeKindFromTypes(["locality", "political"])).toBe("city");
    expect(placeKindFromTypes(["country"])).toBe("region");
    expect(placeKindFromTypes(["point_of_interest"])).toBe("landmark");
    expect(placeKindFromTypes([])).toBe("place");
    expect(placeKindFromTypes(null)).toBe("place");
  });
});
